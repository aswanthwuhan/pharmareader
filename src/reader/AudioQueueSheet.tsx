/**
 * Save audio ahead: pick chapters (or, in a PDF, a page range) and render their
 * sentences into the on-device audio cache, so playback needs no synthesis.
 *
 * The sheet doubles as the run's progress view: `progress` non-null swaps the
 * pickers for "Saving chapter 2 of 5 — 14 of 120 sentences" and a Stop. Closing
 * it never cancels the queue — the player's "…" menu carries the same progress
 * and the same Stop, and reading and playback go on.
 */
import { useEffect, useId, useRef, useState } from 'react';
import './AudioQueueSheet.css';
import { pushBackHandler } from '../core/backButton';

export interface AudioQueueChapter {
  index: number;
  title: string;
  /** Sentences the reader would speak: the player's plan for this chapter. */
  sentences: number;
  /** Every one of those sentences is already in the cache for this voice and rate. */
  saved: boolean;
}

export type AudioQueueSelection =
  | { kind: 'chapters'; chapterIndexes: number[] }
  | { kind: 'pages'; from: number; to: number };

export interface AudioQueueProgress {
  done: number;
  total: number;
  /** The sentence the whole queue is on, worded for the line under the bar. */
  status: string;
}

export interface AudioQueueSheetProps {
  chapters: AudioQueueChapter[];
  /** PDF only: the book's last page. Absent for a text book. */
  pageCount?: number;
  /** PDF only: sentences that start on each page; index 0 is page 1. */
  pageSentences?: number[];
  progress: AudioQueueProgress | null;
  /** Chapters the last run could not finish, by title. */
  failed?: string[];
  onSave(selection: AudioQueueSelection): void;
  onCancelQueue(): void;
  onClose(): void;
}

export default function AudioQueueSheet({
  chapters,
  pageCount,
  pageSentences,
  progress,
  failed = [],
  onSave,
  onCancelQueue,
  onClose,
}: AudioQueueSheetProps) {
  const titleId = useId();
  const sheetRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const [mode, setMode] = useState<'chapters' | 'pages'>('chapters');
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set());
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const running = progress !== null;
  const canPickPages = pageCount !== undefined && pageCount > 0;
  const selectable = chapters.filter((chapter) => chapter.sentences > 0);
  const chosen = chapters.filter((chapter) => selected.has(chapter.index)).map((chapter) => chapter.index);
  const allChosen = selectable.length > 0 && selectable.every((chapter) => selected.has(chapter.index));

  const fromPage = Number.parseInt(from, 10);
  const toPage = Number.parseInt(to, 10);
  const bothPages = Number.isFinite(fromPage) && Number.isFinite(toPage);
  const pagesInRange =
    bothPages && fromPage >= 1 && toPage >= fromPage && toPage <= (pageCount ?? 0);
  const pageSentencesTotal = pagesInRange
    ? (pageSentences ?? []).slice(fromPage - 1, toPage).reduce((sum, count) => sum + count, 0)
    : 0;

  let pageHint = 'Enter the first and last page.';
  if (from !== '' && to !== '' && !bothPages) {
    pageHint = 'Pages are whole numbers.';
  } else if (bothPages && (fromPage < 1 || toPage > (pageCount ?? 0))) {
    pageHint = `Enter pages 1 to ${pageCount ?? 1}.`;
  } else if (bothPages && toPage < fromPage) {
    pageHint = 'The last page must not come before the first.';
  } else if (pagesInRange && pageSentencesTotal === 0) {
    pageHint = 'No sentences to read on those pages.';
  } else if (pagesInRange) {
    pageHint = `${pageSentencesTotal === 1 ? '1 sentence' : `${pageSentencesTotal} sentences`} on pages ${fromPage}–${toPage}.`;
  }

  const chapterLabel = chosen.length === 0 ? 'Save chapters' : chosen.length === 1 ? 'Save 1 chapter' : `Save ${chosen.length} chapters`;
  const primaryLabel = mode === 'pages' ? (pagesInRange ? `Save pages ${fromPage}–${toPage}` : 'Save pages') : chapterLabel;
  const canSave =
    mode === 'pages' ? pagesInRange && pageSentencesTotal > 0 : chosen.length > 0;

  useEffect(() => {
    const active = document.activeElement;
    const returnTo =
      active instanceof HTMLElement && active !== document.body
        ? active
        : document.querySelector<HTMLElement>('[data-tour="more"]');
    sheetRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !sheetRef.current) return;
      // The controls in the sheet change while a queue runs, so the trap is
      // computed on each Tab rather than kept as two fixed refs.
      const nodes = [...sheetRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')];
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === sheetRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    // Android back closes the sheet, not the reader underneath it. The queue is
    // untouched: closing is not stopping.
    const dispose = pushBackHandler(() => {
      onCloseRef.current();
      return true;
    });

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      dispose();
      if (returnTo && document.contains(returnTo)) returnTo.focus();
    };
  }, []);

  function toggle(index: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function save() {
    if (mode === 'pages') {
      if (!pagesInRange || pageSentencesTotal === 0) return;
      onSave({ kind: 'pages', from: fromPage, to: toPage });
      return;
    }
    if (chosen.length === 0) return;
    onSave({ kind: 'chapters', chapterIndexes: chosen });
  }

  return (
    <>
      <div className="sheet-backdrop" onClick={() => onCloseRef.current()} />
      <div className="sheet aq-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={sheetRef} tabIndex={-1}>
        <h2 id={titleId} className="sheet-title">
          Save audio
        </h2>

        {running ? (
          <div className="aq-running">
            <p className="aq-status" role="status">
              {progress.status}
            </p>
            <div
              className="progress"
              role="progressbar"
              aria-label="Sentences saved"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.done}
            >
              <span style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} />
            </div>
          </div>
        ) : (
          <>
            <p className="aq-intro muted">
              Pick what to save. A saved sentence plays with no waiting and keeps working offline.
            </p>

            {canPickPages ? (
              <div className="aq-tabs" role="group" aria-label="Choose chapters or pages">
                <button
                  type="button"
                  className="btn btn-secondary aq-tab"
                  aria-pressed={mode === 'chapters'}
                  onClick={() => setMode('chapters')}
                >
                  Chapters
                </button>
                <button
                  type="button"
                  className="btn btn-secondary aq-tab"
                  aria-pressed={mode === 'pages'}
                  onClick={() => setMode('pages')}
                >
                  Pages
                </button>
              </div>
            ) : null}

            {mode === 'pages' ? (
              <div className="aq-pages">
                <div className="aq-page-row">
                  <label className="aq-page-label" htmlFor={`${titleId}-from`}>
                    From page
                  </label>
                  <input
                    id={`${titleId}-from`}
                    className="aq-page-input"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={pageCount}
                    value={from}
                    onChange={(event) => setFrom(event.target.value)}
                  />
                </div>
                <div className="aq-page-row">
                  <label className="aq-page-label" htmlFor={`${titleId}-to`}>
                    To page
                  </label>
                  <input
                    id={`${titleId}-to`}
                    className="aq-page-input"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={pageCount}
                    value={to}
                    onChange={(event) => setTo(event.target.value)}
                  />
                </div>
                <p className="aq-hint muted" role="status">
                  {pageHint}
                </p>
              </div>
            ) : (
              <>
                <div className="aq-list-head">
                  <span className="aq-list-title">Chapters</span>
                  <div className="aq-selects">
                    <button
                      type="button"
                      className="btn btn-ghost aq-select"
                      disabled={allChosen}
                      onClick={() => setSelected(new Set(selectable.map((chapter) => chapter.index)))}
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost aq-select"
                      disabled={selected.size === 0}
                      onClick={() => setSelected(new Set())}
                    >
                      Clear
                    </button>
                  </div>
                </div>
                <div className="aq-list" role="group" aria-label="Chapters to save">
                  {chapters.map((chapter) => (
                    <label key={chapter.index} className="aq-row">
                      <input
                        type="checkbox"
                        className="aq-check"
                        checked={selected.has(chapter.index)}
                        disabled={chapter.sentences === 0}
                        onChange={() => toggle(chapter.index)}
                      />
                      <span className="aq-text">
                        <span className="aq-title">{chapter.title}</span>
                        <span className="aq-count">
                          {chapter.sentences === 1 ? '1 sentence' : `${chapter.sentences} sentences`}
                        </span>
                      </span>
                      {chapter.saved ? <span className="aq-saved">Saved</span> : null}
                    </label>
                  ))}
                </div>
              </>
            )}

            {failed.length > 0 ? (
              <p className="aq-error" role="alert">
                Could not save {failed.join(', ')}.
              </p>
            ) : null}
          </>
        )}

        <p className="aq-note muted">Saved audio shares this device’s storage with books and voice models.</p>
        <p className="aq-note muted">
          {running ? 'Saving goes on if you close this sheet, and playback keeps going.' : 'Playback keeps going while it saves.'}
        </p>

        <div className="sheet-actions aq-actions">
          {running ? (
            <>
              <button type="button" className="btn btn-secondary" onClick={onCancelQueue}>
                Stop saving
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => onCloseRef.current()}>
                Close
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn-secondary" onClick={() => onCloseRef.current()}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={!canSave} onClick={save}>
                {primaryLabel}
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
