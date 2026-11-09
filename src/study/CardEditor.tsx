import { useEffect, useId, useRef, useState } from 'react';
import type { CardRecord } from '../core/types';
import TopicPicker from '../syllabus/TopicPicker';
import './study.css';

export interface CardDraft {
  id?: string;
  front: string;
  back: string;
  kind: 'qa' | 'cloze';
  topicIds: string[];
}

export default function CardEditor({
  card,
  onSave,
  onCancel,
}: {
  card?: CardRecord;
  onSave: (draft: CardDraft) => void;
  onCancel: () => void;
}) {
  const [front, setFront] = useState(card?.front ?? '');
  const [back, setBack] = useState(card?.back ?? '');
  const [kind, setKind] = useState<'qa' | 'cloze'>(card?.kind ?? 'qa');
  const [topicIds, setTopicIds] = useState<string[]>(card?.topicIds ?? []);
  // Unique per editor: a fixed id would point two editors' labels at the same field.
  const fieldId = useId();
  const kindId = `${fieldId}-kind`;
  const frontId = `${fieldId}-front`;
  const backId = `${fieldId}-back`;
  const titleId = `${fieldId}-title`;
  const frontRef = useRef<HTMLTextAreaElement>(null);

  const canSave = front.trim().length > 0 && back.trim().length > 0;

  // A sheet opens with the cursor where the typing starts, and closes on Escape.
  useEffect(() => {
    frontRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <>
      <div className="sheet-backdrop" onClick={onCancel} />
      <div className="sheet study-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className="sheet-title">
          {card ? 'Edit card' : 'New card'}
        </h2>
        <p className="study-sheet-sub">
          {kind === 'cloze'
            ? 'The gap is written as […] inside the text.'
            : 'A short question on the front, the answer on the back.'}
        </p>

        <form
          className="study-form"
          aria-label={card ? 'Edit card' : 'New card'}
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSave) return;
            onSave({ id: card?.id, front: front.trim(), back, kind, topicIds });
          }}
        >
          <label className="field" htmlFor={kindId}>
            <span className="field-label">Card type</span>
            <select
              id={kindId}
              className="input"
              value={kind}
              onChange={(event) => setKind(event.target.value as 'qa' | 'cloze')}
            >
              <option value="qa">Q&amp;A</option>
              <option value="cloze">Cloze</option>
            </select>
          </label>

          <label className="field" htmlFor={frontId}>
            <span className="field-label">Front</span>
            <textarea
              id={frontId}
              ref={frontRef}
              rows={3}
              value={front}
              onChange={(event) => setFront(event.target.value)}
              placeholder={kind === 'cloze' ? 'Use [...] for the gap' : 'Question'}
            />
            {kind === 'cloze' ? (
              <span className="field-hint">Mark the missing word with [...]. It becomes a blank to fill in.</span>
            ) : null}
          </label>

          <label className="field" htmlFor={backId}>
            <span className="field-label">Back</span>
            <textarea
              id={backId}
              rows={4}
              value={back}
              onChange={(event) => setBack(event.target.value)}
              placeholder="Answer"
            />
          </label>

          <TopicPicker value={topicIds} onChange={setTopicIds} />

          <div className="sheet-actions">
            <button type="button" className="btn btn-secondary" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={!canSave}>
              Save card
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
