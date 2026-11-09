import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useId, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { db } from '../core/db';
import type { BookRecord, CardRecord } from '../core/types';
import TopicPicker from '../syllabus/TopicPicker';
import CardEditor, { type CardDraft } from '../study/CardEditor';
import ReviewSession from '../study/ReviewSession';
import { createCard, deleteCard, exportCardsCsv, exportNotesMarkdown, listCards, updateCard } from '../study/api';
import '../study/study.css';

const TABS = [
  { id: 'review', label: 'Review' },
  { id: 'cards', label: 'Cards' },
  { id: 'export', label: 'Export' },
] as const;

type TabId = (typeof TABS)[number]['id'];

function downloadFile(filename: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking straight away cancels the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* --- Icons -----------------------------------------------------------------
   Inline SVG, one drawing hand: 24px grid, 1.7 stroke, round joins, currentColor.
   -------------------------------------------------------------------------- */
function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 7h15" />
      <path d="M9.5 7V4.8h5V7" />
      <path d="M6.6 7l.8 12.3a1.8 1.8 0 0 0 1.8 1.7h5.6a1.8 1.8 0 0 0 1.8-1.7L17.4 7" />
      <path d="M10.4 11v6M13.6 11v6" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 4v11" />
      <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
      <path d="M5 19.5h14" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 9.5 6 6 6-6" />
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
 * The topic filter lives behind a sheet: one compact chip on the page opens the
 * full picker, so the reading column keeps its space for the card.
 */
function TopicFilterSheet({
  topicIds,
  onChange,
  onClose,
}: {
  topicIds: string[];
  onChange: (ids: string[]) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const doneRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // A sheet opens with focus inside it, and closes on Escape. Mount-only, so a
  // live-query render cannot steal focus back while the user picks topics.
  useEffect(() => {
    doneRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') closeRef.current();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet study-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className="sheet-title">
          Filter by topic
        </h2>
        <p className="study-sheet-sub">Show only the cards tagged with the topics you pick.</p>
        <TopicPicker label="Topics" value={topicIds} onChange={onChange} />
        <div className="sheet-actions">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={topicIds.length === 0}
            onClick={() => onChange([])}
          >
            Clear all
          </button>
          <button ref={doneRef} type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </>
  );
}

export default function ReviewPage() {
  const [tab, setTab] = useState<TabId>('review');
  const [searchParams] = useSearchParams();
  const topicParam = searchParams.get('topic');
  // Syllabus rows link here as /review?topic=<id>; start with that topic pre-selected.
  const [topicIds, setTopicIds] = useState<string[]>(() => (topicParam ? [topicParam] : []));
  // Keep the filter in step when only the query string changes (back/forward).
  useEffect(() => {
    if (topicParam) setTopicIds([topicParam]);
  }, [topicParam]);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<CardRecord | 'new' | null>(null);
  const [exportBookId, setExportBookId] = useState('');
  const [status, setStatus] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  // The sheet and the clear button both remove themselves; keep focus on the chip that opened them.
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const closeFilter = () => {
    setFilterOpen(false);
    filterButtonRef.current?.focus();
  };

  const cards = useLiveQuery(() => listCards(), [], []);
  // Topics are small rows: reading them all is how the filter chip gets its name.
  const topics = useLiveQuery(() => db.topics.toArray(), [], []);
  const topicTitles = topicIds
    .map((id) => topics.find((topic) => topic.id === id)?.title)
    .filter((title): title is string => Boolean(title));
  const filterLabel =
    topicIds.length === 0
      ? 'All topics'
      : topicTitles.length === 1
        ? topicTitles[0]
        : topicTitles.length > 1
          ? `${topicTitles.length} topics`
          : 'Selected topic';
  // Book records carry their file blob, so only read them when the export tab needs the list.
  const books = useLiveQuery<BookRecord[], BookRecord[]>(
    () => (tab === 'export' ? db.books.orderBy('title').toArray() : Promise.resolve([])),
    [tab],
    [],
  );

  const query = search.trim().toLowerCase();
  const visibleCards = query
    ? cards.filter((card) => card.front.toLowerCase().includes(query) || card.back.toLowerCase().includes(query))
    : cards;

  async function saveCard(draft: CardDraft) {
    try {
      if (draft.id) {
        await updateCard(draft.id, { front: draft.front, back: draft.back, kind: draft.kind, topicIds: draft.topicIds });
      } else {
        await createCard({ front: draft.front, back: draft.back, kind: draft.kind, topicIds: draft.topicIds });
      }
      setEditing(null);
      setStatus('Card saved.');
    } catch {
      setStatus('Could not save the card.');
    }
  }

  async function downloadNotes() {
    try {
      const markdown = await exportNotesMarkdown(exportBookId || undefined);
      downloadFile(`pharmareader-notes-${new Date().toISOString().slice(0, 10)}.md`, markdown, 'text/markdown;charset=utf-8');
      setStatus('Notes downloaded.');
    } catch {
      setStatus('Could not export notes.');
    }
  }

  async function downloadCards() {
    try {
      const csv = await exportCardsCsv();
      downloadFile(`pharmareader-cards-${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv;charset=utf-8');
      setStatus('Cards downloaded.');
    } catch {
      setStatus('Could not export cards.');
    }
  }

  return (
    <section className="page study-page">
      <header className="app-bar">
        <div>
          <h1>Review</h1>
          <p className="app-bar-sub">
            {cards.length === 1 ? '1 card in your deck' : `${cards.length} cards in your deck`}
          </p>
        </div>
      </header>

      <div className="study-controls">
        <div className="study-tabs" role="group" aria-label="Study">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={tab === item.id}
              className="study-tab"
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        {tab === 'review' ? (
          <div className={`study-filter${topicIds.length > 0 ? ' is-filtered' : ''}`}>
            <button
              type="button"
              ref={filterButtonRef}
              className="study-filter-main"
              aria-haspopup="dialog"
              aria-expanded={filterOpen}
              aria-label={topicIds.length > 0 ? `Filter by topic: ${filterLabel}` : 'Filter by topic'}
              onClick={() => setFilterOpen(true)}
            >
              <span className="study-filter-text" title={topicTitles[0]}>
                {filterLabel}
              </span>
              {topicIds.length === 0 ? <ChevronDownIcon /> : null}
            </button>
            {topicIds.length > 0 ? (
              <button
                type="button"
                className="study-filter-clear"
                aria-label="Clear topic filter"
                onClick={() => {
                  setTopicIds([]);
                  filterButtonRef.current?.focus();
                }}
              >
                <CrossIcon />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {tab === 'review' ? (
        <div className="study-panel">
          <ReviewSession topicIds={topicIds} />
        </div>
      ) : null}

      {tab === 'cards' ? (
        <div className="study-panel">
          <div className="cards-toolbar">
            <label className="field cards-search" htmlFor="card-search">
              <span className="field-label">Search cards</span>
              <input
                id="card-search"
                className="input"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Front or back"
              />
            </label>
            <button type="button" className="btn btn-primary cards-new" onClick={() => setEditing('new')}>
              New card
            </button>
          </div>

          {cards.length === 0 ? (
            <p className="muted study-note">
              No cards yet. Make one from a highlight in the reader, or write one with “New card”.
            </p>
          ) : null}
          {cards.length > 0 && visibleCards.length === 0 ? (
            <p className="muted study-note">No cards match “{search}”.</p>
          ) : null}

          {visibleCards.length > 0 ? (
            <ul className="list study-cards">
              {visibleCards.map((card) => (
                <li key={card.id} className="list-row card-row">
                  <button type="button" className="card-open" onClick={() => setEditing(card)}>
                    <span className="badge card-kind">{card.kind === 'qa' ? 'Q&A' : 'Cloze'}</span>
                    <span className="card-front">{card.front}</span>
                    <span className="card-back">{card.back.length > 160 ? `${card.back.slice(0, 160)}…` : card.back}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-icon btn-ghost card-delete"
                    aria-label={`Delete card: ${card.front}`}
                    onClick={() => {
                      if (!window.confirm('Delete this card and its review history?')) return;
                      void deleteCard(card.id)
                        .then(() => {
                          // A card open in the editor would otherwise stay editable after deletion.
                          setEditing((open) => (open && open !== 'new' && open.id === card.id ? null : open));
                          setStatus('Card deleted.');
                        })
                        .catch(() => setStatus('Could not delete the card.'));
                    }}
                  >
                    <TrashIcon />
                    <span className="visually-hidden">Delete</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {tab === 'export' ? (
        <div className="study-panel">
          <section className="card export-card">
            <h2 className="card-title">Notes</h2>
            <p className="card-body">Highlights with their notes, grouped by book and chapter, as Markdown.</p>
            <label className="field" htmlFor="export-book">
              <span className="field-label">Book</span>
              <select
                id="export-book"
                className="input"
                value={exportBookId}
                onChange={(event) => setExportBookId(event.target.value)}
              >
                <option value="">All books</option>
                {books.map((book) => (
                  <option key={book.id} value={book.id}>
                    {book.title}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="btn btn-primary btn-block" onClick={() => void downloadNotes()}>
              <DownloadIcon />
              Download notes (.md)
            </button>
          </section>

          <section className="card export-card">
            <h2 className="card-title">Flashcards</h2>
            <p className="card-body">Anki text import: front;back;tags. Tags are syllabus topic titles.</p>
            <button type="button" className="btn btn-secondary btn-block" onClick={() => void downloadCards()}>
              <DownloadIcon />
              Download cards (.csv)
            </button>
          </section>
        </div>
      ) : null}

      {editing ? (
        <CardEditor
          key={editing === 'new' ? 'new' : editing.id}
          card={editing === 'new' ? undefined : editing}
          onSave={(draft) => void saveCard(draft)}
          onCancel={() => setEditing(null)}
        />
      ) : null}

      {filterOpen ? (
        <TopicFilterSheet topicIds={topicIds} onChange={setTopicIds} onClose={closeFilter} />
      ) : null}

      {status ? (
        <p className="study-status" role="status">
          {status}
        </p>
      ) : null}
    </section>
  );
}
