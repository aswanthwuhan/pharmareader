import { useEffect, useMemo, useRef, useState } from 'react';
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
    <div className="syl-overlay" onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="syl-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tag-books-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="tag-books-title">Tag books for “{topic.title}”</h2>
        <p className="syl-empty">Books ticked here appear under this topic and feed its progress.</p>
        {(books ?? []).length === 0 && <p className="syl-empty">No books in the library yet.</p>}
        {(books ?? []).map((book) => (
          <label className="syl-check" key={book.id}>
            <input type="checkbox" checked={book.topicIds.includes(topic.id)} onChange={() => void toggle(book)} />
            <span>{book.title}</span>
          </label>
        ))}
        <p style={{ marginTop: 12 }}>
          <button type="button" className="syl-btn" onClick={onClose}>
            Done
          </button>
        </p>
      </div>
    </div>
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
    <>
      {books && books.length > 0 ? (
        <ul className="syl-books">
          {books.map((book) => (
            <li key={book.id}>{book.title}</li>
          ))}
        </ul>
      ) : (
        <p className="syl-empty">No books tagged yet.</p>
      )}
      <button type="button" className="syl-btn" onClick={onTag}>
        Tag books
      </button>
    </>
  );
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

function ProgressLine({ progress }: { progress?: TopicProgress }) {
  const cards = progress?.cards ?? 0;
  const mature = progress?.mature ?? 0;
  const percent = cards > 0 ? Math.round((mature / cards) * 100) : 0;
  return (
    <div className="syl-meta">
      <div className="syl-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={`${mature} of ${cards} cards mature`}>
        <span style={{ width: `${percent}%` }} />
      </div>
      <span>
        {mature}/{cards} mature
      </span>
      <span>{plural(progress?.books ?? 0, 'book')}</span>
      <span>{plural(progress?.highlights ?? 0, 'highlight')}</span>
      {(progress?.reviewedToday ?? 0) > 0 && <span>{plural(progress?.reviewedToday ?? 0, 'card')} reviewed today</span>}
    </div>
  );
}

export default function SyllabusPage() {
  const [filter, setFilter] = useState<'all' | Topic['level']>('all');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [edit, setEdit] = useState<Edit | null>(null);
  const [tagFor, setTagFor] = useState<Topic | null>(null);

  useEffect(() => {
    void ensureSyllabusSeeded();
  }, []);

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

      return (
        <li className="syl-node" key={node.id}>
          <div className="syl-row" style={{ paddingLeft: 4 + depth * 10 }}>
            {filter === 'all' && (
              <button
                type="button"
                className="syl-twisty"
                aria-expanded={open}
                aria-label={`${open ? 'Collapse' : 'Expand'} ${node.title}`}
                onClick={() => toggleExpanded(node.id)}
              >
                {open ? '▾' : '▸'}
              </button>
            )}
            <button
              type="button"
              className={`syl-title${filter !== 'all' && node.level !== filter ? ' is-ancestor' : ''}`}
              aria-expanded={open}
              onClick={() => toggleExpanded(node.id)}
            >
              <span>{node.title}</span>
              <span className={`syl-badge lvl-${node.level}`}>{LEVEL_LABEL[node.level]}</span>
            </button>
            <ProgressLine progress={nodeProgress} />
          </div>

          {open && (
            <div className="syl-detail" style={filter === 'all' ? undefined : { paddingLeft: 8 + depth * 10 }}>
              <div className="syl-actions">
                <button
                  type="button"
                  className="syl-btn"
                  onClick={() => setEdit({ mode: 'rename', targetId: node.id, value: node.title })}
                >
                  Rename
                </button>
                <select
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
                <button type="button" className="syl-btn" onClick={() => setEdit({ mode: 'add', parentId: node.id, value: '' })}>
                  Add subtopic
                </button>
                <div className="syl-move">
                  <button
                    type="button"
                    className="syl-btn"
                    aria-label={`Move ${node.title} up`}
                    disabled={!canReorder || index === 0}
                    onClick={() => void moveTopic(node.id, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="syl-btn"
                    aria-label={`Move ${node.title} down`}
                    disabled={!canReorder || index === nodes.length - 1}
                    onClick={() => void moveTopic(node.id, 1)}
                  >
                    ↓
                  </button>
                </div>
                <button type="button" className="syl-btn danger" onClick={() => void remove(node)}>
                  Delete
                </button>
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
                    aria-label={`New name for ${node.title}`}
                    value={editing ? editValue : ''}
                    onChange={(event) => setEdit({ mode: 'rename', targetId: node.id, value: event.target.value })}
                  />
                  <button type="submit" className="syl-btn">
                    Save
                  </button>
                  <button type="button" className="syl-btn" onClick={() => setEdit(null)}>
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
                    aria-label={`New sub-topic under ${node.title}`}
                    placeholder="New sub-topic title"
                    value={adding ? editValue : ''}
                    onChange={(event) => setEdit({ mode: 'add', parentId: node.id, value: event.target.value })}
                  />
                  <button type="submit" className="syl-btn">
                    Add
                  </button>
                  <button type="button" className="syl-btn" onClick={() => setEdit(null)}>
                    Cancel
                  </button>
                </form>
              )}

              <LinkedBooks topicId={node.id} onTag={() => setTagFor(node)} />
              <p style={{ marginBottom: 0 }}>
                <Link className="syl-btn" to={`/review?topic=${encodeURIComponent(node.id)}`}>
                  Review this topic
                </Link>
              </p>
            </div>
          )}

          {node.children.length > 0 && (open || filter !== 'all') && (
            <ul className="syl-sublist">{renderNodes(node.children, depth + 1)}</ul>
          )}
        </li>
      );
    });

  const addingDomain = edit !== null && edit.mode === 'add' && edit.parentId === null;
  const filterOptions: ('all' | Topic['level'])[] = ['all', ...LEVELS];

  return (
    <section className="page">
      <h1>Syllabus</h1>
      <p className="muted">
        MD Pharmacology topics, basic to advanced. Tag books and cards to a topic to see how much of it is mature.
      </p>

      <div className="syl-toolbar">
        <div className="syl-filters" role="group" aria-label="Filter by level">
          {filterOptions.map((level) => (
            <button
              key={level}
              type="button"
              className="syl-filter"
              aria-pressed={filter === level}
              onClick={() => setFilter(level)}
            >
              {level === 'all' ? 'All' : LEVEL_LABEL[level]}
            </button>
          ))}
        </div>
        <button type="button" className="syl-btn" onClick={() => void reset()}>
          Reset to defaults
        </button>
      </div>

      {topics.length === 0 && <p className="syl-empty">Preparing the default syllabus…</p>}

      <ul className="syl-list">{renderNodes(filteredTree, 0)}</ul>

      {filteredTree.length > 0 && (
        <p>
          <button type="button" className="syl-btn" onClick={() => setEdit({ mode: 'add', parentId: null, value: '' })}>
            + Add domain
          </button>
        </p>
      )}

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
            aria-label="New domain title"
            placeholder="New domain title"
            value={edit.mode === 'add' ? edit.value : ''}
            onChange={(event) => setEdit({ mode: 'add', parentId: null, value: event.target.value })}
          />
          <button type="submit" className="syl-btn">
            Add
          </button>
          <button type="button" className="syl-btn" onClick={() => setEdit(null)}>
            Cancel
          </button>
        </form>
      )}

      {tagFor && <TagBooksDialog topic={tagFor} onClose={() => setTagFor(null)} />}
    </section>
  );
}
