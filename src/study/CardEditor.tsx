import { useId, useState } from 'react';
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

  const canSave = front.trim().length > 0 && back.trim().length > 0;

  return (
    <form
      className="study-card"
      aria-label={card ? 'Edit card' : 'New card'}
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSave) return;
        onSave({ id: card?.id, front: front.trim(), back, kind, topicIds });
      }}
    >
      <div className="study-field">
        <label htmlFor={kindId}>Card type</label>
        <select id={kindId} className="study-select" value={kind} onChange={(event) => setKind(event.target.value as 'qa' | 'cloze')}>
          <option value="qa">Q&amp;A</option>
          <option value="cloze">Cloze</option>
        </select>
      </div>

      <div className="study-field">
        <label htmlFor={frontId}>Front</label>
        <textarea
          id={frontId}
          className="study-textarea"
          rows={3}
          value={front}
          onChange={(event) => setFront(event.target.value)}
          placeholder={kind === 'cloze' ? 'Use [...] for the gap' : 'Question'}
        />
      </div>

      <div className="study-field">
        <label htmlFor={backId}>Back</label>
        <textarea
          id={backId}
          className="study-textarea"
          rows={4}
          value={back}
          onChange={(event) => setBack(event.target.value)}
          placeholder="Answer"
        />
      </div>

      <div className="study-field">
        <span className="study-label">Topics</span>
        <TopicPicker value={topicIds} onChange={setTopicIds} />
      </div>

      <div className="study-row">
        <button type="submit" className="study-btn primary" disabled={!canSave}>
          Save card
        </button>
        <button type="button" className="study-btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
