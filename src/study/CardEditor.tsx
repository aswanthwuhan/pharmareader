import { useState } from 'react';
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
        <label htmlFor="card-kind">Card type</label>
        <select id="card-kind" className="study-select" value={kind} onChange={(event) => setKind(event.target.value as 'qa' | 'cloze')}>
          <option value="qa">Q&amp;A</option>
          <option value="cloze">Cloze</option>
        </select>
      </div>

      <div className="study-field">
        <label htmlFor="card-front">Front</label>
        <textarea
          id="card-front"
          className="study-textarea"
          rows={3}
          value={front}
          onChange={(event) => setFront(event.target.value)}
          placeholder={kind === 'cloze' ? 'Use [...] for the gap' : 'Question'}
        />
      </div>

      <div className="study-field">
        <label htmlFor="card-back">Back</label>
        <textarea
          id="card-back"
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
