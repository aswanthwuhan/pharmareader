/**
 * The toolbar that appears over a text selection: highlight it, annotate it,
 * bookmark the sentence, turn it into a card, or hand it to the AI.
 */
import { useEffect, useRef, useState } from 'react';

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
      <p className="rd-select-text">{text.length > 140 ? `${text.slice(0, 140)}…` : text}</p>

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
          <textarea id="rd-note" value={note} rows={3} onChange={(event) => setNote(event.target.value)} autoFocus />
          <div className="rd-note-actions">
            <button type="submit" className="rd-btn" disabled={!note.trim()}>
              Save note
            </button>
            <button type="button" className="rd-btn" onClick={() => setNoteOpen(false)}>
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
            <button type="button" className="rd-btn" aria-label="Extend selection by one sentence" onClick={onExtend}>
              + Sentence
            </button>
            <button type="button" className="rd-btn" onClick={() => setNoteOpen(true)}>
              Note
            </button>
            <button type="button" className="rd-btn" onClick={onBookmark}>
              Bookmark
            </button>
            <button type="button" className="rd-btn" onClick={() => onCard('qa')}>
              Q&amp;A card
            </button>
            <button type="button" className="rd-btn" onClick={() => onCard('cloze')}>
              Cloze card
            </button>
            <button type="button" className="rd-btn" aria-label="AI actions" onClick={onAi}>
              AI
            </button>
            <button type="button" className="rd-btn rd-select-close" aria-label="Close actions" onClick={onClose}>
              ✕
            </button>
          </div>
        </>
      )}
    </div>
  );
}
