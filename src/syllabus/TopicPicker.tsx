import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
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

interface PanelBox {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <path d="m5 12.5 4.5 4.5L19 7" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={open ? 'tp-chevron is-open' : 'tp-chevron'}
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

function CrossIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round">
      <path d="M7 7l10 10M17 7 7 17" />
    </svg>
  );
}

/**
 * Compact multi-select for topics: chips of what is chosen, a searchable
 * dropdown tree of everything else. The input keeps focus and drives the
 * listbox through aria-activedescendant, so it works from the keyboard.
 *
 * The panel is positioned with fixed coordinates taken from the input, because
 * the picker is used inside bottom sheets whose scroll container would clip it.
 */
export default function TopicPicker({ value, onChange, label = 'Topics' }: TopicPickerProps) {
  const reactId = useId();
  const inputId = `${reactId}-input`;
  const listId = `${reactId}-list`;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [active, setActive] = useState(0);
  const [panelBox, setPanelBox] = useState<PanelBox | null>(null);

  const topics = useLiveQuery(() => db.topics.toArray(), []) ?? [];
  const tree = useMemo(() => buildTopicTree(topics), [topics]);
  const titles = useMemo(() => new Map(topics.map((t) => [t.id, t.title])), [topics]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const q = query.trim().toLowerCase();
    const walk = (nodes: TopicNode[], depth: number, ancestors: string[], showAll: boolean) => {
      for (const node of nodes) {
        const parent = ancestors[ancestors.length - 1];
        // Match the whole ancestor path, so searching a domain name also finds its topics.
        const haystack = [...ancestors, node.title].join(' ').toLowerCase();
        const matches = !q || haystack.includes(q);
        if (matches) {
          out.push({ id: node.id, title: node.title, level: node.level, depth, parent, hasChildren: node.children.length > 0 });
        }
        if (showAll || expanded.has(node.id)) walk(node.children, depth + 1, [...ancestors, node.title], showAll);
      }
    };
    walk(tree, 0, [], q.length > 0);
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

  // Keep the floating panel glued to the input while the sheet scrolls or the window resizes.
  useEffect(() => {
    if (!open) {
      setPanelBox(null);
      return;
    }
    const measure = () => {
      const el = inputRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const gap = 8;
      const width = Math.min(rect.width, window.innerWidth - gap * 2);
      const left = Math.max(gap, Math.min(rect.left, window.innerWidth - width - gap));
      const spaceBelow = window.innerHeight - rect.bottom - gap;
      const spaceAbove = rect.top - gap;
      const above = spaceBelow < 240 && spaceAbove > spaceBelow;
      setPanelBox({
        left,
        width,
        maxHeight: Math.max(160, Math.min(360, above ? spaceAbove : spaceBelow)),
        ...(above ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
      });
    };
    measure();
    window.addEventListener('resize', measure);
    document.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      document.removeEventListener('scroll', measure, true);
    };
  }, [open]);

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
      if (!open) {
        // First ArrowDown opens the list on the first row; it must not skip row 0.
        openPicker();
        setActive(0);
        return;
      }
      setActive((i) => Math.min(i + 1, Math.max(rows.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        openPicker();
        setActive(0);
        return;
      }
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
      <label className="tp-label" htmlFor={inputId}>
        {label}
      </label>

      {value.length > 0 && (
        <div className="tp-chips">
          {value.map((id) => {
            const title = titles.get(id);
            if (!title) return null;
            return (
              <span className="tp-chip" key={id}>
                <span className="tp-chip-text">{title}</span>
                <button type="button" className="tp-chip-remove" aria-label={`Remove ${title}`} onClick={() => toggle(id)}>
                  <CrossIcon />
                </button>
              </span>
            );
          })}
        </div>
      )}

      <input
        ref={inputRef}
        id={inputId}
        className="input tp-input"
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

      {open && panelBox && (
        <div
          className="tp-panel"
          id={listId}
          role="listbox"
          aria-label={label}
          aria-multiselectable="true"
          style={{
            left: panelBox.left,
            width: panelBox.width,
            maxHeight: panelBox.maxHeight,
            ...(panelBox.bottom !== undefined ? { bottom: panelBox.bottom } : { top: panelBox.top }),
          }}
        >
          {rows.length === 0 && <p className="tp-empty">No topic matches “{query}”.</p>}
          {rows.map((row, index) => {
            const selected = value.includes(row.id);
            const rowExpanded = expanded.has(row.id);
            return (
              <div
                key={row.id}
                id={`${reactId}-opt-${row.id}`}
                role="option"
                aria-selected={selected}
                className={`tp-option${index === active ? ' is-active' : ''}`}
                style={{ '--depth': row.depth } as CSSProperties}
                onMouseEnter={() => setActive(index)}
                onClick={() => toggle(row.id)}
              >
                <span className="tp-box" aria-hidden="true">
                  {selected ? <CheckIcon /> : null}
                </span>
                <span className="tp-name">
                  <span className="tp-title">{row.title}</span>
                  {row.parent && <span className="tp-parent">{row.parent}</span>}
                </span>
                {row.depth === 0 && <span className="tp-level">{LEVEL_LABEL[row.level]}</span>}
                {row.hasChildren && (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={rowExpanded ? `Collapse ${row.title}` : `Expand ${row.title}`}
                    className="tp-twisty syl-twisty"
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
                    <ChevronIcon open={rowExpanded} />
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
