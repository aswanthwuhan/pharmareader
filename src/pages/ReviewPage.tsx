import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { db } from '../core/db';
import type { CardRecord } from '../core/types';
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

export default function ReviewPage() {
  const [tab, setTab] = useState<TabId>('review');
  const [topicIds, setTopicIds] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<CardRecord | 'new' | null>(null);
  const [exportBookId, setExportBookId] = useState('');
  const [status, setStatus] = useState('');

  const cards = useLiveQuery(() => listCards(), [], []);
  const books = useLiveQuery(() => db.books.orderBy('title').toArray(), [], []);

  const query = search.trim().toLowerCase();
  const visibleCards = query
    ? cards.filter((card) => card.front.toLowerCase().includes(query) || card.back.toLowerCase().includes(query))
    : cards;

  async function saveCard(draft: CardDraft) {
    if (draft.id) {
      await updateCard(draft.id, { front: draft.front, back: draft.back, kind: draft.kind, topicIds: draft.topicIds });
    } else {
      await createCard({ front: draft.front, back: draft.back, kind: draft.kind, topicIds: draft.topicIds });
    }
    setEditing(null);
    setStatus('Card saved.');
  }

  async function downloadNotes() {
    const markdown = await exportNotesMarkdown(exportBookId || undefined);
    downloadFile(`pharmareader-notes-${new Date().toISOString().slice(0, 10)}.md`, markdown, 'text/markdown;charset=utf-8');
    setStatus('Notes downloaded.');
  }

  async function downloadCards() {
    const csv = await exportCardsCsv();
    downloadFile(`pharmareader-cards-${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv;charset=utf-8');
    setStatus('Cards downloaded.');
  }

  return (
    <section className="page">
      <h1>Review</h1>

      <div className="study-tabs" role="tablist" aria-label="Study">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={`panel-${item.id}`}
            className="study-tab"
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'review' ? (
        <div role="tabpanel" id="panel-review" aria-labelledby="tab-review">
          <div className="study-field">
            <span className="study-label">Filter by topic</span>
            <TopicPicker value={topicIds} onChange={setTopicIds} />
          </div>
          <ReviewSession topicIds={topicIds} />
        </div>
      ) : null}

      {tab === 'cards' ? (
        <div role="tabpanel" id="panel-cards" aria-labelledby="tab-cards">
          <div className="study-row">
            <button type="button" className="study-btn primary" onClick={() => setEditing('new')}>
              New card
            </button>
          </div>

          {editing ? (
            <CardEditor
              key={editing === 'new' ? 'new' : editing.id}
              card={editing === 'new' ? undefined : editing}
              onSave={(draft) => void saveCard(draft)}
              onCancel={() => setEditing(null)}
            />
          ) : null}

          <div className="study-field">
            <label htmlFor="card-search">Search cards</label>
            <input
              id="card-search"
              className="study-input"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Front or back"
            />
          </div>

          {cards.length === 0 ? <p className="muted">No cards yet. Make one from a highlight or with “New card”.</p> : null}
          {cards.length > 0 && visibleCards.length === 0 ? <p className="muted">No cards match “{search}”.</p> : null}

          <ul className="study-list">
            {visibleCards.map((card) => (
              <li key={card.id} className="study-card">
                <span className="study-badge">{card.kind === 'qa' ? 'Q&A' : 'Cloze'}</span>
                <p className="study-front">{card.front}</p>
                <p className="study-meta">{card.back.length > 160 ? `${card.back.slice(0, 160)}…` : card.back}</p>
                <div className="study-row">
                  <button type="button" className="study-btn" onClick={() => setEditing(card)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="study-btn danger"
                    onClick={() => {
                      void deleteCard(card.id);
                      setStatus('Card deleted.');
                    }}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {tab === 'export' ? (
        <div role="tabpanel" id="panel-export" aria-labelledby="tab-export">
          <div className="study-card">
            <h2>Notes</h2>
            <p className="muted">Highlights with their notes, grouped by book and chapter, as Markdown.</p>
            <div className="study-field">
              <label htmlFor="export-book">Book</label>
              <select
                id="export-book"
                className="study-select"
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
            </div>
            <button type="button" className="study-btn primary" onClick={() => void downloadNotes()}>
              Download notes (.md)
            </button>
          </div>

          <div className="study-card">
            <h2>Flashcards</h2>
            <p className="muted">Anki text import: front;back;tags. Tags are syllabus topic titles.</p>
            <button type="button" className="study-btn primary" onClick={() => void downloadCards()}>
              Download cards (.csv)
            </button>
          </div>
        </div>
      ) : null}

      <p className="muted" role="status">
        {status}
      </p>
    </section>
  );
}
