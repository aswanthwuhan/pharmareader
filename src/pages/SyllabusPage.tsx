import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import { db } from '../core/db';
import type { Topic } from '../core/types';
import { ensureSyllabusSeeded, resetToDefault } from '../syllabus/seed';
import {
  addSubtopic,
  buildTopicTree,
  deleteTopic,
  LEVELS,
  LEVEL_LABEL,
  moveTopic,
  renameTopic,
  setTopicLevel,
  type TopicNode,
} from '../syllabus/topics';
import { topicProgressAll, type TopicProgress } from '../syllabus/progress';
import '../syllabus/syllabus.css';

type Edit = { mode: 'rename'; targetId: string; value: string } | { mode: 'add'; parentId: string | null; value: string };

interface BookStub {
  id: string;
  title: string;
  topicIds: string[];
}

/* --- Icons -----------------------------------------------------------------
   Inline SVG, one drawing hand: 24px grid, 1.7 stroke, round joins, currentColor.
   -------------------------------------------------------------------------- */
function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={open ? 'syl-chevron is-open' : 'syl-chevron'}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m9 5.5 7 6.5-7 6.5" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor">
      <circle cx="6" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="18" cy="12" r="1.6" />
    </svg>
  );
}

/**
 * Books carry their whole parsed text, so the panel reads them one at a time
 * and keeps only the three fields it needs.
 */
async function loadBookStubs(): Promise<BookStub[]> {
  const out: BookStub[] = [];
  await db.books.each((book) => {
    out.push({ id: book.id, title: book.title, topicIds: book.topicIds ?? [] });
  });
  return out;
}

function TagBooksDialog({ topic, onClose }: { topic: Topic; onClose: () => void }) {
  const books = useLiveQuery(loadBookStubs, []);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggle = async (book: BookStub) => {
    const ids = book.topicIds;
    const next = ids.includes(topic.id) ? ids.filter((id) => id !== topic.id) : [...ids, topic.id];
    await db.books.update(book.id, { topicIds: next });
  };

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="sheet syl-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tag-books-title"
      >
        <h2 id="tag-books-title" className="sheet-title">
          Tag books for “{topic.title}”
        </h2>
        <p className="syl-sheet-sub">Books ticked here appear under this topic and feed its progress.</p>
        {(books ?? []).length === 0 ? <p className="syl-empty">No books in the library yet.</p> : null}
        <ul className="syl-check-list">
          {(books ?? []).map((book) => (
            <li key={book.id}>
              <label className="syl-check">
                <input type="checkbox" checked={book.topicIds.includes(topic.id)} onChange={() => void toggle(book)} />
                <span>{book.title}</span>
              </label>
            </li>
          ))}
        </ul>
        <div className="sheet-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </>
  );
}

function LinkedBooks({ topicId, onTag }: { topicId: string; onTag: () => void }) {
  const books = useLiveQuery(async () => {
    const out: { id: string; title: string }[] = [];
    await db.books.where('topicIds').equals(topicId).each((book) => {
      out.push({ id: book.id, title: book.title });
    });
    return out;
  }, [topicId]);

  return (
    <div className="syl-block">
      <div className="syl-block-head">
        <h3>Books</h3>
        <button type="button" className="btn btn-ghost syl-tag" onClick={onTag}>
          Tag books
        </button>
      </div>
      {books && books.length > 0 ? (
        <ul className="syl-books">
          {books.map((book) => (
            <li key={book.id}>{book.title}</li>
          ))}
        </ul>
      ) : (
        <p className="syl-empty">No books tagged yet. Tag a book to feed this topic’s progress.</p>
      )}
    </div>
  );
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

function ProgressLine({ progress }: { progress?: TopicProgress }) {
  const cards = progress?.cards ?? 0;
  const mature = progress?.mature ?? 0;
  const books = progress?.books ?? 0;
  const highlights = progress?.highlights ?? 0;
  const reviewedToday = progress?.reviewedToday ?? 0;
  // A tree of 237 topics cannot afford a row of zeroes on every node: the line
  // appears with the first card, book or highlight, and silence means "not started".
  if (cards === 0 && books === 0 && highlights === 0 && reviewedToday === 0) return null;
  const percent = cards > 0 ? Math.round((mature / cards) * 100) : 0;
  return (
    <div className="syl-meta">
      {cards > 0 ? (
        <div
          className="progress syl-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={`${mature} of ${cards} cards mature`}
        >
          <span style={{ width: `${percent}%` }} />
        </div>
      ) : null}
      <span className="syl-stat tnum">{cards > 0 ? `${mature}/${cards} mature` : 'No cards yet'}</span>
      <span className="syl-stat">{plural(books, 'book')}</span>
      <span className="syl-stat">{plural(highlights, 'highlight')}</span>
      {reviewedToday > 0 ? <span className="syl-stat">{plural(reviewedToday, 'card')} reviewed today</span> : null}
    </div>
  );
}

export default function SyllabusPage() {
  const [filter, setFilter] = useState<'all' | Topic['level']>('all');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [edit, setEdit] = useState<Edit | null>(null);
  const [tagFor, setTagFor] = useState<Topic | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void ensureSyllabusSeeded();
  }, []);

  // One popover at a time: outside press and Escape both put it away.
  useEffect(() => {
    if (!menuFor) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target as HTMLElement | null)?.closest?.('.syl-menu-wrap')) setMenuFor(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuFor(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuFor]);

  const topics = useLiveQuery(() => db.topics.toArray(), []) ?? [];
  const progress = useLiveQuery(() => topicProgressAll(), []);
  const tree = useMemo(() => buildTopicTree(topics), [topics]);

  const filteredTree = useMemo(() => {
    if (filter === 'all') return tree;
    const keep = (node: TopicNode): TopicNode | null => {
      const children = node.children.map(keep).filter((child): child is TopicNode => child !== null);
      if (node.level === filter || children.length > 0) return { ...node, children };
      return null;
    };
    return tree.map(keep).filter((node): node is TopicNode => node !== null);
  }, [tree, filter]);

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submitEdit = async () => {
    if (!edit) return;
    const value = edit.value.trim();
    if (!value) {
      setEdit(null);
      return;
    }
    if (edit.mode === 'rename') {
      await renameTopic(edit.targetId, value);
    } else {
      const parent = edit.parentId ? topics.find((t) => t.id === edit.parentId) : undefined;
      const id = await addSubtopic(edit.parentId, value, parent?.level ?? 'basic');
      setExpanded((prev) => new Set(prev).add(edit.parentId ?? id));
    }
    setEdit(null);
  };

  const countDescendants = (node: TopicNode): number =>
    node.children.reduce((total, child) => total + 1 + countDescendants(child), 0);

  const remove = async (node: TopicNode) => {
    if (!node.custom) {
      const extra = countDescendants(node);
      const ok = window.confirm(
        `Delete “${node.title}”${extra > 0 ? ` and its ${extra} sub-topics` : ''}?\n\nThis is a built-in topic; “Reset to defaults” brings it back.`,
      );
      if (!ok) return;
    }
    await deleteTopic(node.id);
    setExpanded((prev) => {
      const next = new Set(prev);
      next.delete(node.id);
      return next;
    });
  };

  const reset = async () => {
    if (!window.confirm('Restore the built-in syllabus? Edits to built-in topics are undone; topics you created are kept.')) return;
    await resetToDefault();
    setExpanded(new Set());
  };

  const renderNodes = (nodes: TopicNode[], depth: number) =>
    nodes.map((node, index) => {
      const open = expanded.has(node.id);
      const editing = edit !== null && edit.mode === 'rename' && edit.targetId === node.id;
      const adding = edit !== null && edit.mode === 'add' && edit.parentId === node.id;
      const editValue = edit?.value ?? '';
      const canReorder = filter === 'all';
      const nodeProgress = progress?.get(node.id);
      const ancestor = filter !== 'all' && node.level !== filter;

      return (
        <li className="syl-node" key={node.id}>
          <div className="syl-row" style={{ '--depth': depth } as CSSProperties}>
            {filter === 'all' ? (
              <button
                type="button"
                className="syl-twisty"
                aria-expanded={open}
                aria-label={`${open ? 'Collapse' : 'Expand'} ${node.title}`}
                onClick={() => toggleExpanded(node.id)}
              >
                <ChevronIcon open={open} />
              </button>
            ) : (
              // A filtered tree has nothing to twist, but keeps the column so
              // titles stay put when the filter changes.
              <span className="syl-twisty-spacer" aria-hidden="true" />
            )}

            <div className="syl-row-content">
              <button
                type="button"
                className={`syl-title${ancestor ? ' is-ancestor' : ''}`}
                aria-expanded={open}
                onClick={() => toggleExpanded(node.id)}
              >
                <span className="syl-title-text">{node.title}</span>
                {ancestor ? null : (
                  <span className={`badge syl-badge lvl-${node.level}`}>{LEVEL_LABEL[node.level]}</span>
                )}
              </button>
              <ProgressLine progress={nodeProgress} />

              {open && (
                <div className="syl-detail">
                  <div className="syl-actions">
                    <label className="syl-level">
                      <span className="syl-level-label">Level</span>
                      <select
                        className="input syl-select"
                        aria-label={`Level for ${node.title}`}
                        value={node.level}
                        onChange={(event) => void setTopicLevel(node.id, event.target.value as Topic['level'])}
                      >
                        {LEVELS.map((level) => (
                          <option key={level} value={level}>
                            {LEVEL_LABEL[level]}
                          </option>
                        ))}
                      </select>
                    </label>

                    <div className="syl-menu-wrap">
                      <button
                        type="button"
                        className="btn btn-secondary syl-menu-btn"
                        aria-haspopup="menu"
                        aria-expanded={menuFor === node.id}
                        onClick={() => setMenuFor(menuFor === node.id ? null : node.id)}
                      >
                        Actions
                        <MoreIcon />
                      </button>

                      {menuFor === node.id && (
                        <div ref={menuRef} className="syl-menu" role="menu" aria-label={`Actions for ${node.title}`}>
                          <button
                            type="button"
                            role="menuitem"
                            className="syl-menu-item"
                            onClick={() => {
                              setMenuFor(null);
                              setEdit({ mode: 'rename', targetId: node.id, value: node.title });
                            }}
                          >
                            Rename
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="syl-menu-item"
                            onClick={() => {
                              setMenuFor(null);
                              setEdit({ mode: 'add', parentId: node.id, value: '' });
                            }}
                          >
                            Add subtopic
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="syl-menu-item"
                            aria-label={`Move ${node.title} up`}
                            disabled={!canReorder || index === 0}
                            onClick={() => {
                              setMenuFor(null);
                              void moveTopic(node.id, -1);
                            }}
                          >
                            Move up
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="syl-menu-item"
                            aria-label={`Move ${node.title} down`}
                            disabled={!canReorder || index === nodes.length - 1}
                            onClick={() => {
                              setMenuFor(null);
                              void moveTopic(node.id, 1);
                            }}
                          >
                            Move down
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="syl-menu-item syl-menu-danger"
                            onClick={() => {
                              setMenuFor(null);
                              void remove(node);
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {editing && (
                    <form
                      className="syl-edit-row"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void submitEdit();
                      }}
                    >
                      <input
                        autoFocus
                        className="input"
                        aria-label={`New name for ${node.title}`}
                        value={editing ? editValue : ''}
                        onChange={(event) => setEdit({ mode: 'rename', targetId: node.id, value: event.target.value })}
                      />
                      <button type="submit" className="btn btn-primary">
                        Save
                      </button>
                      <button type="button" className="btn btn-ghost" onClick={() => setEdit(null)}>
                        Cancel
                      </button>
                    </form>
                  )}

                  {adding && (
                    <form
                      className="syl-edit-row"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void submitEdit();
                      }}
                    >
                      <input
                        autoFocus
                        className="input"
                        aria-label={`New sub-topic under ${node.title}`}
                        placeholder="New sub-topic title"
                        value={adding ? editValue : ''}
                        onChange={(event) => setEdit({ mode: 'add', parentId: node.id, value: event.target.value })}
                      />
                      <button type="submit" className="btn btn-primary">
                        Add
                      </button>
                      <button type="button" className="btn btn-ghost" onClick={() => setEdit(null)}>
                        Cancel
                      </button>
                    </form>
                  )}

                  <LinkedBooks topicId={node.id} onTag={() => setTagFor(node)} />

                  <Link className="btn btn-primary btn-block syl-cta" to={`/review?topic=${encodeURIComponent(node.id)}`}>
                    Review this topic
                  </Link>
                </div>
              )}
            </div>
          </div>

          {node.children.length > 0 && (open || filter !== 'all') && (
            <ul className="syl-sublist">{renderNodes(node.children, depth + 1)}</ul>
          )}
        </li>
      );
    });

  const addingDomain = edit !== null && edit.mode === 'add' && edit.parentId === null;
  const filterOptions: ('all' | Topic['level'])[] = ['all', ...LEVELS];

  return (
    <section className="page syl-page">
      <header className="app-bar">
        <div>
          <h1>Syllabus</h1>
          <p className="app-bar-sub">
            {topics.length === 0
              ? 'Loading topics…'
              : `${plural(topics.length, 'topic')} · tag books and cards to track progress`}
          </p>
        </div>
      </header>

      <div className="syl-toolbar">
        <div className="syl-filters" role="group" aria-label="Filter by level">
          {filterOptions.map((level) => (
            <button
              key={level}
              type="button"
              className="chip chip-tap syl-filter"
              aria-pressed={filter === level}
              onClick={() => {
                setFilter(level);
                setMenuFor(null);
              }}
            >
              {level === 'all' ? 'All' : LEVEL_LABEL[level]}
            </button>
          ))}
        </div>
      </div>

      {topics.length === 0 ? <p className="syl-empty">Preparing the default syllabus…</p> : null}

      <ul className="syl-list">{renderNodes(filteredTree, 0)}</ul>

      {filteredTree.length > 0 ? (
        <div className="syl-add-domain">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setEdit({ mode: 'add', parentId: null, value: '' })}
          >
            + Add domain
          </button>
        </div>
      ) : null}

      {/* Rare and destructive: it sits under the list it rewrites, not above it. */}
      <button type="button" className="btn btn-ghost syl-reset" onClick={() => void reset()}>
        Reset to defaults
      </button>

      {addingDomain && (
        <form
          className="syl-edit-row"
          onSubmit={(event) => {
            event.preventDefault();
            void submitEdit();
          }}
        >
          <input
            autoFocus
            className="input"
            aria-label="New domain title"
            placeholder="New domain title"
            value={edit.mode === 'add' ? edit.value : ''}
            onChange={(event) => setEdit({ mode: 'add', parentId: null, value: event.target.value })}
          />
          <button type="submit" className="btn btn-primary">
            Add
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setEdit(null)}>
            Cancel
          </button>
        </form>
      )}

      {tagFor && <TagBooksDialog topic={tagFor} onClose={() => setTagFor(null)} />}
    </section>
  );
}
