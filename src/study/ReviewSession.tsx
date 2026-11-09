import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { fsrs, type Grade } from 'ts-fsrs';
import { db } from '../core/db';
import type { CardRecord } from '../core/types';
import { dueCards, fromFsrs, reviewCard } from './api';
import './study.css';

/** Book rows carry the file blob and the parsed document, so load a title once. */
const bookTitleCache = new Map<string, string>();

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
  const parts = text.split(/\[\s*(?:\.{3}|…)\s*\]/);
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

/* --- Icons -----------------------------------------------------------------
   Inline SVG, one drawing hand: 1.7 stroke, round joins, currentColor.
   -------------------------------------------------------------------------- */
function CompleteMark() {
  return (
    <svg className="empty-state-mark" viewBox="0 0 48 48" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M24 5.5 40 12v11.6c0 8.3-6.4 15.4-16 18.9-9.6-3.5-16-10.6-16-18.9V12L24 5.5Z" />
      <path d="m17.4 24.3 4.6 4.6 8.8-9.4" />
    </svg>
  );
}

function QuietMark() {
  return (
    <svg className="empty-state-mark" viewBox="0 0 48 48" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 13.5h26v25H11z" />
      <path d="M11 20.5h26M18 8.5v6M30 8.5v6" />
      <path d="M17 27h6M17 32.5h10" />
    </svg>
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

  // Source caption: the book a card came from, never the whole books table.
  const [sourceTitle, setSourceTitle] = useState<string | null>(null);
  const bookId = current?.bookId;
  useEffect(() => {
    if (!bookId) {
      setSourceTitle(null);
      return;
    }
    const cached = bookTitleCache.get(bookId);
    if (cached !== undefined) {
      setSourceTitle(cached || null);
      return;
    }
    let alive = true;
    setSourceTitle(null);
    db.books
      .get(bookId)
      .then((book) => {
        bookTitleCache.set(bookId, book?.title ?? '');
        if (alive) setSourceTitle(book?.title ?? null);
      })
      .catch(() => {
        bookTitleCache.set(bookId, '');
      });
    return () => {
      alive = false;
    };
  }, [bookId]);

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
    // Pos is the number of ratings given; an empty queue straight away means nothing was rated.
    const rated = pos;
    return (
      <section className="empty-state study-done" aria-label="Review session">
        {rated > 0 ? <CompleteMark /> : <QuietMark />}
        <h2>{rated > 0 ? 'Session complete' : 'Nothing due'}</h2>
        <p>
          {rated > 0
            ? `You rated ${rated} ${rated === 1 ? 'card' : 'cards'}. Each one comes back when its interval ends, so there is nothing to repeat today.`
            : 'No cards are due right now. Cards return when their interval ends; new cards come from highlights in the reader and from the Cards tab.'}
        </p>
        <div className="empty-state-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setLoadToken((token) => token + 1)}
          >
            Check for more
          </button>
        </div>
      </section>
    );
  }

  const cardLabel = current.kind === 'cloze' ? 'Cloze' : 'Q&A';
  const done = pos + 1;
  const percentage = (done / queue.length) * 100;

  return (
    <section className="review" aria-label="Review session">
      <div className="review-meter">
        <p className="review-status tnum" aria-live="polite">
          <span className="review-due">
            <span className="review-due-dot" aria-hidden="true" />
            {queue.length - pos} due
          </span>{' '}
          <span className="review-card-count">
            Card {done} of {queue.length}
          </span>
        </p>
        <div
          className="progress"
          role="progressbar"
          aria-label="Review progress"
          aria-valuetext={`Card ${done} of ${queue.length}`}
          aria-valuemin={1}
          aria-valuemax={queue.length}
          aria-valuenow={done}
        >
          <span style={{ width: `${percentage}%` }} />
        </div>
      </div>

      <article className="card review-card">
        <div className="review-card-head">
          <span className="badge">{cardLabel}</span>
          {sourceTitle ? (
            <span className="review-source" title={sourceTitle}>
              {sourceTitle}
            </span>
          ) : null}
        </div>
        <p className="review-front">
          {current.kind === 'cloze' ? <ClozeText text={current.front} /> : current.front}
        </p>
        {revealed ? (
          <div className="review-answer">
            <span className="review-answer-label">Answer</span>
            <p className="review-back">
              {current.kind === 'cloze' ? <ClozeText text={current.back} /> : current.back}
            </p>
          </div>
        ) : null}
      </article>

      {error ? (
        <p className="review-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="review-dock">
        <div className="review-dock-inner">
          {revealed ? (
            <>
              <div className="review-ratings" role="group" aria-label="Rate this card">
                {RATINGS.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    className={`btn review-rate rate-${value}`}
                    disabled={busy}
                    aria-label={`${label}, next review in ${previews?.[value] ?? 'unknown'}`}
                    onClick={() => void rate(value)}
                  >
                    <span className="review-rate-label">{label}</span>
                    <small className="rate-gap">{previews?.[value]}</small>
                  </button>
                ))}
              </div>
              <p className="review-hint">
                Press <kbd>1</kbd>–<kbd>4</kbd> to rate.
              </p>
            </>
          ) : (
            <>
              <button type="button" className="btn btn-primary btn-block review-reveal" onClick={() => setRevealed(true)}>
                Show answer
              </button>
              <p className="review-hint">
                Press <kbd>Space</kbd> to show the answer.
              </p>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
