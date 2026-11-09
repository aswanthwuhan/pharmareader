import { useState } from 'react';
import { useSetting } from '../core/settings';
import { createCard } from '../study/api';
import { generateCards, summarize, type GeneratedCard } from './tasks';
import './ai.css';

export interface AiActionsProps {
  text: string;
  bookId?: string;
  topicIds?: string[];
  onClose(): void;
}

type Row = GeneratedCard & { checked: boolean };

/** Selection actions: turn a passage into flashcards or into a revision summary. */
export default function AiActions({ text, bookId, topicIds, onClose }: AiActionsProps) {
  const enabled = useSetting('ai.enabled', false);
  const [busy, setBusy] = useState<'cards' | 'summary' | 'save' | null>(null);
  const [error, setError] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [summary, setSummary] = useState('');
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(0);

  const selected = rows?.filter((r) => r.checked).length ?? 0;

  async function makeCards() {
    setBusy('cards');
    setError('');
    setSaved(0);
    setSummary('');
    try {
      const cards = await generateCards(text);
      setRows(cards.map((c) => ({ ...c, checked: true })));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  }

  async function makeSummary() {
    setBusy('summary');
    setError('');
    setSaved(0);
    setRows(null);
    try {
      setSummary(await summarize(text));
      setCopied(false);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  }

  async function saveSelected() {
    if (!rows) return;
    const chosen = rows.filter((r) => r.checked);
    if (!chosen.length) return;
    setBusy('save');
    setError('');
    try {
      for (const card of chosen) {
        await createCard({
          kind: card.kind,
          front: card.front,
          back: card.back,
          bookId,
          topicIds: topicIds ?? [],
        });
      }
      setSaved(chosen.length);
      setRows(null);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  }

  async function copySummary() {
    try {
      await navigator.clipboard.writeText(summary);
      setCopied(true);
    } catch {
      setError('Could not copy — select the text and copy it manually.');
    }
  }

  return (
    <section className="ai-section" aria-labelledby="ai-actions-heading">
      <div className="ai-head">
        <h2 id="ai-actions-heading">AI</h2>
        <button type="button" className="ai-btn" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="ai-actions-row">
        <button
          type="button"
          className="ai-btn primary"
          onClick={() => void makeCards()}
          disabled={!enabled || busy !== null}
        >
          {busy === 'cards' ? 'Working…' : 'Make cards'}
        </button>
        <button
          type="button"
          className="ai-btn"
          onClick={() => void makeSummary()}
          disabled={!enabled || busy !== null}
        >
          {busy === 'summary' ? 'Working…' : 'Summarize'}
        </button>
      </div>

      {!enabled && (
        <p className="ai-notice">Turn on AI in Settings → AI to make cards or summaries from this text.</p>
      )}

      {rows && (
        <>
          <p className="ai-notice">Uncheck anything you do not want to save.</p>
          <ul className="ai-cards">
            {rows.map((row, i) => (
              <li key={`${i}-${row.front.slice(0, 24)}`} className="ai-card">
                <input
                  type="checkbox"
                  id={`ai-card-${i}`}
                  checked={row.checked}
                  onChange={(e) =>
                    setRows((prev) =>
                      prev ? prev.map((r, j) => (j === i ? { ...r, checked: e.target.checked } : r)) : prev,
                    )
                  }
                />
                <label htmlFor={`ai-card-${i}`}>
                  <span className={`ai-kind ai-kind-${row.kind}`}>{row.kind === 'qa' ? 'Q&A' : 'Cloze'}</span>
                  <span className="ai-front">{row.front}</span>
                  <span className="ai-back">{row.back}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="ai-actions-row">
            <button
              type="button"
              className="ai-btn primary"
              onClick={() => void saveSelected()}
              disabled={selected === 0 || busy !== null}
            >
              {busy === 'save' ? 'Saving…' : `Save ${selected} card${selected === 1 ? '' : 's'}`}
            </button>
            <button type="button" className="ai-btn" onClick={() => setRows(null)} disabled={busy !== null}>
              Discard
            </button>
          </div>
        </>
      )}

      {summary && (
        <>
          <pre className="ai-summary">{summary}</pre>
          <div className="ai-actions-row">
            <button type="button" className="ai-btn" onClick={() => void copySummary()}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </>
      )}

      {saved > 0 && (
        <p className="ai-ok" role="status">
          Saved {saved} card{saved === 1 ? '' : 's'}.
        </p>
      )}
      {error && (
        <p className="ai-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
