import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../core/db';
import type { Topic } from '../core/types';
import { buildTopicTree, LEVEL_LABEL, type TopicNode } from './topics';
import './syllabus.css';

export interface TopicPickerProps {
  value: string[];
  onChange: (ids: string[]) => void;
  label?: string;
}

interface Row {
  id: string;
  title: string;
  level: Topic['level'];
  depth: number;
  parent?: string;
  hasChildren: boolean;
}

/**
 * Compact multi-select for topics: chips of what is chosen, a searchable
 * dropdown tree of everything else. The input keeps focus and drives the
 * listbox through aria-activedescendant, so it works from the keyboard.
 */
export default function TopicPicker({ value, onChange, label = 'Topics' }: TopicPickerProps) {
  const reactId = useId();
  const listId = `${reactId}-list`;
  const rootRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [active, setActive] = useState(0);

  const topics = useLiveQuery(() => db.topics.toArray(), []) ?? [];
  const tree = useMemo(() => buildTopicTree(topics), [topics]);
  const titles = useMemo(() => new Map(topics.map((t) => [t.id, t.title])), [topics]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const q = query.trim().toLowerCase();
    const walk = (nodes: TopicNode[], depth: number, parent: string | undefined, showAll: boolean) => {
      for (const node of nodes) {
        const matches = !q || node.title.toLowerCase().includes(q) || (parent ?? '').toLowerCase().includes(q);
        if (matches) {
          out.push({ id: node.id, title: node.title, level: node.level, depth, parent, hasChildren: node.children.length > 0 });
        }
        if (showAll || expanded.has(node.id)) walk(node.children, depth + 1, node.title, showAll);
      }
    };
    walk(tree, 0, undefined, q.length > 0);
    return out;
  }, [tree, expanded, query]);

  useEffect(() => {
    setActive((i) => Math.min(i, Math.max(rows.length - 1, 0)));
  }, [rows.length]);

  const activeRow = rows[active];
  const activeId = activeRow ? `${reactId}-opt-${activeRow.id}` : undefined;

  useEffect(() => {
    if (!open || !activeId) return;
    document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeId]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const toggle = useCallback(
    (id: string) => {
      onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
    },
    [onChange, value],
  );

  const openPicker = () => {
    // Show the branches that already contain a selection, so chosen topics are visible.
    const selected = new Set(value);
    const next = new Set(expanded);
    const mark = (nodes: TopicNode[]): boolean => {
      let found = false;
      for (const node of nodes) {
        const childFound = mark(node.children);
        if (selected.has(node.id) || childFound) {
          next.add(node.id);
          found = true;
        }
      }
      return found;
    };
    mark(tree);
    setExpanded(next);
    setOpen(true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, rows.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActive(Math.max(rows.length - 1, 0));
    } else if (event.key === 'Enter') {
      if (!open) return;
      event.preventDefault();
      if (activeRow) toggle(activeRow.id);
    } else if (event.key === 'Escape') {
      setOpen(false);
    } else if (event.key === 'ArrowRight' && activeRow?.hasChildren) {
      event.preventDefault();
      setExpanded((prev) => new Set(prev).add(activeRow.id));
    } else if (event.key === 'ArrowLeft' && activeRow?.hasChildren) {
      event.preventDefault();
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(activeRow.id);
        return next;
      });
    }
  };

  return (
    <div className="tp-root" ref={rootRef}>
      <label className="muted" htmlFor={`${reactId}-input`}>
        {label}
      </label>
      {value.length > 0 && (
        <div className="tp-chips">
          {value.map((id) => {
            const title = titles.get(id);
            if (!title) return null;
            return (
              <span className="tp-chip" key={id}>
                {title}
                <button type="button" aria-label={`Remove ${title}`} onClick={() => toggle(id)}>
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}
      <input
        id={`${reactId}-input`}
        className="tp-input"
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open ? activeId : undefined}
        placeholder="Search topics…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={openPicker}
        onClick={openPicker}
        onKeyDown={onKeyDown}
      />
      {open && (
        <div className="tp-panel" id={listId} role="listbox" aria-label={label} aria-multiselectable="true">
          {rows.length === 0 && <p className="tp-empty">No topic matches “{query}”.</p>}
          {rows.map((row, index) => {
            const selected = value.includes(row.id);
            return (
              <div
                key={row.id}
                id={`${reactId}-opt-${row.id}`}
                role="option"
                aria-selected={selected}
                className={`tp-option${index === active ? ' is-active' : ''}`}
                style={{ paddingLeft: 8 + row.depth * 16 }}
                onMouseEnter={() => setActive(index)}
                onClick={() => toggle(row.id)}
              >
                <span className="tp-box" aria-hidden="true">
                  {selected ? '✓' : ''}
                </span>
                <span className="tp-name">
                  {row.title}
                  {row.parent && <span className="tp-parent">{row.parent}</span>}
                </span>
                <span className={`syl-badge lvl-${row.level}`}>{LEVEL_LABEL[row.level]}</span>
                {row.hasChildren && (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={expanded.has(row.id) ? `Collapse ${row.title}` : `Expand ${row.title}`}
                    className="syl-twisty"
                    style={{ width: 32, flexBasis: 32 }}
                    onClick={(event) => {
                      event.stopPropagation();
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(row.id)) next.delete(row.id);
                        else next.add(row.id);
                        return next;
                      });
                    }}
                  >
                    {expanded.has(row.id) ? '▾' : '▸'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
