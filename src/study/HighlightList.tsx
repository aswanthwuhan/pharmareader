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
    <section className="study-highlights" aria-label="Highlights and bookmarks">
      <h2>Highlights</h2>
      {highlights.length === 0 ? <p className="muted">Highlight a sentence to keep it here.</p> : null}
      <ul className="study-list">
        {highlights.map((highlight) => {
          const target = highlight.sentenceIds[0];
          return (
            <li key={highlight.id} className={`study-card hl-${highlight.color}`}>
              <button
                type="button"
                className="study-link"
                disabled={!target}
                onClick={() => target && onJump(target)}
                title="Jump to this sentence"
              >
                {highlight.text}
              </button>

              {editingNote === highlight.id ? (
                <div className="study-field">
                  <label htmlFor={`note-${highlight.id}`}>Note</label>
                  <textarea
                    id={`note-${highlight.id}`}
                    className="study-textarea"
                    rows={3}
                    value={noteDraft}
                    onChange={(event) => setNoteDraft(event.target.value)}
                  />
                  <div className="study-row">
                    <button type="button" className="study-btn primary" onClick={() => void saveNote(highlight.id)}>
                      Save note
                    </button>
                    <button type="button" className="study-btn" onClick={() => setEditingNote(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {highlight.note ? <p className="study-note">Note: {highlight.note}</p> : null}
                  <button
                    type="button"
                    className="study-btn"
                    onClick={() => {
                      setEditingNote(highlight.id);
                      setNoteDraft(highlight.note ?? '');
                    }}
                  >
                    {highlight.note ? 'Edit note' : 'Add note'}
                  </button>
                </>
              )}

              <div className="study-row">
                <label className="study-inline-field">
                  <span>Colour</span>
                  <select
                    className="study-select"
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
                <button type="button" className="study-btn" onClick={() => void makeCard(highlight, 'qa')}>
                  Q&amp;A card
                </button>
                <button type="button" className="study-btn" onClick={() => void makeCard(highlight, 'cloze')}>
                  Cloze card
                </button>
                <button
                  type="button"
                  className="study-btn danger"
                  onClick={() => {
                    // Cards made from the highlight are kept, so say so before removing it.
                    if (!window.confirm('Delete this highlight? Cards made from it are kept.')) return;
                    void deleteHighlight(highlight.id);
                  }}
                >
                  Delete
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <h2>Bookmarks</h2>
      {bookmarks.length === 0 ? <p className="muted">No bookmarks yet.</p> : null}
      <ul className="study-list">
        {bookmarks.map((bookmark) => (
          <li key={bookmark.id} className="study-card">
            <div className="study-row">
              <button type="button" className="study-link" onClick={() => onJump(bookmark.sentenceId)}>
                {bookmark.label ?? 'Bookmark'}
              </button>
              <button type="button" className="study-btn danger" onClick={() => void deleteBookmark(bookmark.id)}>
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>

      <p className="muted" role="status">
        {status}
      </p>
    </section>
  );
}
