import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import type { Highlight } from '../core/types';
import {
  cardFromHighlight,
  createCard,
  deleteBookmark,
  deleteHighlight,
  listBookmarks,
  listHighlights,
  updateHighlight,
} from './api';
import './study.css';

const COLORS: Highlight['color'][] = ['yellow', 'green', 'blue', 'pink'];

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

export default function HighlightList({ bookId, onJump }: { bookId: string; onJump: (sentenceId: string) => void }) {
  const highlights = useLiveQuery(() => listHighlights(bookId), [bookId], []);
  const bookmarks = useLiveQuery(() => listBookmarks(bookId), [bookId], []);
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [status, setStatus] = useState('');

  async function makeCard(highlight: Highlight, kind: 'qa' | 'cloze') {
    try {
      await createCard(cardFromHighlight(highlight, kind));
      setStatus(kind === 'qa' ? 'Q&A card added.' : 'Cloze card added.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not add the card.');
    }
  }

  async function saveNote(id: string) {
    try {
      await updateHighlight(id, { note: noteDraft.trim() || undefined });
      setEditingNote(null);
      setStatus('Note saved.');
    } catch {
      // Keep the editor open so the typed note is not lost.
      setStatus('Could not save the note.');
    }
  }

  return (
    <section className="highlights" aria-label="Highlights and bookmarks">
      <div className="hl-section">
        <div className="hl-head">
          <h2>Highlights</h2>
          {highlights.length > 0 ? <span className="hl-count tnum">{highlights.length}</span> : null}
        </div>
        {highlights.length === 0 ? (
          <p className="muted hl-empty">Highlight a sentence to keep it here. A highlight can hold a note and become a card.</p>
        ) : null}

        <ul className="hl-list">
          {highlights.map((highlight) => {
            const target = highlight.sentenceIds[0];
            return (
              <li key={highlight.id} className={`hl-item hl-${highlight.color}`}>
                <div className="hl-item-head">
                  <span className="hl-swatch" aria-hidden="true" />
                  <button
                    type="button"
                    className="hl-text"
                    disabled={!target}
                    onClick={() => target && onJump(target)}
                    title="Jump to this sentence"
                  >
                    {highlight.text}
                  </button>
                </div>

                {editingNote === highlight.id ? (
                  <div className="hl-note-editor">
                    <label className="field" htmlFor={`note-${highlight.id}`}>
                      <span className="field-label">Note</span>
                      <textarea
                        id={`note-${highlight.id}`}
                        rows={3}
                        value={noteDraft}
                        onChange={(event) => setNoteDraft(event.target.value)}
                      />
                    </label>
                    <div className="hl-note-actions">
                      <button type="button" className="btn btn-primary" onClick={() => void saveNote(highlight.id)}>
                        Save note
                      </button>
                      <button type="button" className="btn btn-ghost" onClick={() => setEditingNote(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {highlight.note ? (
                      <p className="hl-note">
                        <span className="hl-note-label">Note</span>
                        {highlight.note}
                      </p>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-ghost hl-note-btn"
                      onClick={() => {
                        setEditingNote(highlight.id);
                        setNoteDraft(highlight.note ?? '');
                      }}
                    >
                      {highlight.note ? 'Edit note' : 'Add note'}
                    </button>
                  </>
                )}

                <div className="hl-actions">
                  <label className="hl-colour">
                    <span className="hl-colour-label">Colour</span>
                    <select
                      className="input hl-select"
                      value={highlight.color}
                      onChange={(event) => void updateHighlight(highlight.id, { color: event.target.value as Highlight['color'] })}
                    >
                      {COLORS.map((color) => (
                        <option key={color} value={color}>
                          {color}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="button" className="btn btn-secondary hl-action" onClick={() => void makeCard(highlight, 'qa')}>
                    Q&amp;A card
                  </button>
                  <button type="button" className="btn btn-secondary hl-action" onClick={() => void makeCard(highlight, 'cloze')}>
                    Cloze card
                  </button>
                  <button
                    type="button"
                    className="btn btn-icon btn-ghost hl-delete"
                    aria-label="Delete highlight"
                    onClick={() => {
                      // Cards made from the highlight are kept, so say so before removing it.
                      if (!window.confirm('Delete this highlight? Cards made from it are kept.')) return;
                      void deleteHighlight(highlight.id);
                    }}
                  >
                    <TrashIcon />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="hl-section">
        <div className="hl-head">
          <h2>Bookmarks</h2>
          {bookmarks.length > 0 ? <span className="hl-count tnum">{bookmarks.length}</span> : null}
        </div>
        {bookmarks.length === 0 ? <p className="muted hl-empty">No bookmarks yet. Bookmark a page in the reader to keep your place.</p> : null}
        {bookmarks.length > 0 ? (
          <ul className="list hl-bookmarks">
            {bookmarks.map((bookmark) => (
              <li key={bookmark.id} className="list-row hl-bookmark">
                <button type="button" className="hl-bookmark-text" onClick={() => onJump(bookmark.sentenceId)}>
                  {bookmark.label ?? 'Bookmark'}
                </button>
                <button
                  type="button"
                  className="btn btn-icon btn-ghost hl-delete"
                  aria-label="Delete bookmark"
                  onClick={() => void deleteBookmark(bookmark.id)}
                >
                  <TrashIcon />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {status ? (
        <p className="hl-status" role="status">
          {status}
        </p>
      ) : null}
    </section>
  );
}
