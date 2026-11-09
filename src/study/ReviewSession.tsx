import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { fsrs, type Grade } from 'ts-fsrs';
import type { CardRecord } from '../core/types';
import { dueCards, fromFsrs, reviewCard } from './api';
import './study.css';

/** One scheduler for the whole module: `fsrs()` builds models and is not cheap. */
const scheduler = fsrs();

const RATINGS = [
  { value: 1, label: 'Again' },
  { value: 2, label: 'Hard' },
  { value: 3, label: 'Good' },
  { value: 4, label: 'Easy' },
] as const;

/** Compact "next review in …" label for a scheduling gap. */
function formatGap(ms: number): string {
  if (ms <= 0) return 'now';
  const minutes = ms / 60_000;
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

function previewIntervals(card: CardRecord): Record<number, string> {
  const now = new Date();
  const preview = scheduler.repeat(fromFsrs(card.fsrs), now);
  const out: Record<number, string> = {};
  for (const { value } of RATINGS) {
    out[value] = formatGap(preview[value as Grade].card.due.getTime() - now.getTime());
  }
  return out;
}

/** Renders a cloze gap (`[...]`) as a styled blank, announced as "blank". */
function ClozeText({ text }: { text: string }) {
  const parts = text.split(/\[\.\.\.\]|\[…\]/);
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? (
            <>
              <span className="cloze-gap" aria-hidden="true">
                […]
              </span>
              <span className="cloze-blank-label">blank</span>
            </>
          ) : null}
          {part}
        </Fragment>
      ))}
    </>
  );
}

export default function ReviewSession({ topicIds }: { topicIds?: string[] }) {
  const [queue, setQueue] = useState<CardRecord[]>([]);
  const [pos, setPos] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [loadToken, setLoadToken] = useState(0);
  const mounted = useRef(true);
  const topicKey = topicIds?.join(',') ?? '';

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    dueCards(100, topicIds)
      .then((cards) => {
        if (!alive) return;
        setQueue(cards);
        setPos(0);
        setRevealed(false);
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setQueue([]);
        setPos(0);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
    // topicIds is identified by its joined value so a re-created array does not reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicKey, loadToken]);

  const current = queue[pos];
  const previews = useMemo(() => (current ? previewIntervals(current) : null), [current]);

  async function rate(rating: 1 | 2 | 3 | 4) {
    if (!current || busy) return;
    setBusy(true);
    setError('');
    try {
      await reviewCard(current.id, rating);
      if (!mounted.current) return;
      setRevealed(false);
      setPos((p) => p + 1);
    } catch {
      if (mounted.current) setError('That rating could not be saved. Try again.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;
      if (!current) return;
      // Space/Enter belong to whatever control has focus (tabs, links, buttons).
      const onControl = target?.closest?.('button, a, [role="button"], [role="tab"], [role="menuitem"]') != null;
      if ((event.key === ' ' || event.key === 'Enter') && !revealed) {
        if (onControl) return;
        event.preventDefault();
        setRevealed(true);
        return;
      }
      if (revealed && ['1', '2', '3', '4'].includes(event.key)) {
        event.preventDefault();
        void rate(Number(event.key) as 1 | 2 | 3 | 4);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // rate is re-created per render; the values it reads are listed instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, revealed, busy]);

  if (loading) return <p className="muted">Loading cards…</p>;

  if (!current) {
    return (
      <section className="study-card" aria-label="Review session">
        <p>{queue.length === 0 ? 'No cards are due right now.' : 'Session complete.'}</p>
        <button type="button" className="study-btn" onClick={() => setLoadToken((token) => token + 1)}>
          Check for more
        </button>
      </section>
    );
  }

  return (
    <section className="study-card" aria-label="Review session">
      <p className="muted" aria-live="polite">
        {queue.length - pos} due · card {pos + 1} of {queue.length}
      </p>

      <p className="study-front">
        {current.kind === 'cloze' ? <ClozeText text={current.front} /> : current.front}
      </p>

      {error ? (
        <p className="study-error" role="alert">
          {error}
        </p>
      ) : null}

      {revealed ? (
        <>
          <p className="study-back">{current.kind === 'cloze' ? <ClozeText text={current.back} /> : current.back}</p>
          <div className="study-row" role="group" aria-label="Rate this card">
            {RATINGS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                className={`study-btn rate-${value}`}
                disabled={busy}
                aria-label={`${label}, next review in ${previews?.[value] ?? 'unknown'}`}
                onClick={() => void rate(value)}
              >
                <span>{label}</span>
                <small className="rate-gap">{previews?.[value]}</small>
              </button>
            ))}
          </div>
          <p className="muted study-hint">Keys 1–4 rate the card.</p>
        </>
      ) : (
        <>
          <button type="button" className="study-btn primary" onClick={() => setRevealed(true)}>
            Show answer
          </button>
          <p className="muted study-hint">Space also shows the answer.</p>
        </>
      )}
    </section>
  );
}
