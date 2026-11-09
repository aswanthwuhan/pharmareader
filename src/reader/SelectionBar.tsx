/**
 * The toolbar that appears over a text selection: highlight it, annotate it,
 * bookmark the sentence, turn it into a card, or hand it to the AI. It wears
 * the same sheet surface and corner radius as every other panel in the app.
 */
import { useEffect, useRef, useState } from 'react';
import { Glyph, icons } from './Icon';

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink';

interface Props {
  text: string;
  count: number;
  onHighlight(color: HighlightColor): void;
  onNote(note: string): void;
  onBookmark(): void;
  onCard(kind: 'qa' | 'cloze'): void;
  onAi(): void;
  onExtend(): void;
  onClose(): void;
}

const COLORS: { color: HighlightColor; label: string }[] = [
  { color: 'yellow', label: 'Yellow highlight' },
  { color: 'green', label: 'Green highlight' },
  { color: 'blue', label: 'Blue highlight' },
  { color: 'pink', label: 'Pink highlight' },
];

export default function SelectionBar({
  text,
  count,
  onHighlight,
  onNote,
  onBookmark,
  onCard,
  onAi,
  onExtend,
  onClose,
}: Props) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const box = useRef<HTMLDivElement>(null);

  // Keyboard and screen-reader users land in the toolbar, not back at the top
  // of the document.
  useEffect(() => {
    box.current?.focus();
  }, []);

  return (
    <div
      ref={box}
      className="rd-select"
      role="dialog"
      aria-modal="true"
      aria-label={`Actions for ${count} selected sentence${count === 1 ? '' : 's'}`}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <div className="rd-select-head">
        <p className="rd-select-text">{text.length > 140 ? `${text.slice(0, 140)}…` : text}</p>
        <button
          type="button"
          className="btn btn-ghost btn-icon rd-select-close"
          aria-label="Close actions"
          onClick={onClose}
        >
          <Glyph>{icons.close}</Glyph>
        </button>
      </div>

      {noteOpen ? (
        <form
          className="rd-note-form"
          onSubmit={(event) => {
            event.preventDefault();
            onNote(note.trim());
            setNote('');
            setNoteOpen(false);
          }}
        >
          <label htmlFor="rd-note">Note</label>
          <textarea
            id="rd-note"
            className="input rd-note-input"
            value={note}
            rows={3}
            onChange={(event) => setNote(event.target.value)}
            autoFocus
          />
          <div className="rd-note-actions">
            <button type="submit" className="btn btn-primary" disabled={!note.trim()}>
              Save note
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setNoteOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="rd-colors" role="group" aria-label="Highlight colour">
            {COLORS.map((entry) => (
              <button
                key={entry.color}
                type="button"
                className={`rd-swatch rd-swatch-${entry.color}`}
                aria-label={entry.label}
                title={entry.label}
                onClick={() => onHighlight(entry.color)}
              >
                <span aria-hidden="true" />
              </button>
            ))}
          </div>

          <div className="rd-select-actions">
            <button
              type="button"
              className="btn btn-ghost rd-action"
              aria-label="Extend selection by one sentence"
              onClick={onExtend}
            >
              <Glyph>{icons.plus}</Glyph><span>Sentence</span>
            </button>
            <button type="button" className="btn btn-ghost rd-action" onClick={() => setNoteOpen(true)}>
              <Glyph>{icons.note}</Glyph><span>Note</span>
            </button>
            <button type="button" className="btn btn-ghost rd-action" onClick={onBookmark}>
              <Glyph>{icons.bookmark}</Glyph><span>Bookmark</span>
            </button>
            <button type="button" className="btn btn-ghost rd-action" onClick={() => onCard('qa')}>
              <Glyph>{icons.card}</Glyph><span>Q&amp;A card</span>
            </button>
            <button type="button" className="btn btn-ghost rd-action" onClick={() => onCard('cloze')}>
              <Glyph>{icons.card}</Glyph><span>Cloze card</span>
            </button>
            <button type="button" className="btn btn-ghost rd-action" aria-label="AI actions" onClick={onAi}>
              <Glyph>{icons.sparkle}</Glyph><span>AI</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
