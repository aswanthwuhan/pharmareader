import { useCallback, useEffect, useRef, useState } from 'react';
import { db } from '../core/db';
import { setSetting, useSetting } from '../core/settings';
import { measureLayoutMs } from './layout/benchmark';
import { reanalyseBook, type ReanalyseResult } from './index';
import type { LayoutMode } from './pdf';
import {
  LAYOUT_MODEL,
  deleteLayoutModel,
  downloadLayoutModel,
  isLayoutModelReady,
} from './layout/model';
import styles from './LayoutModelPanel.module.css';

type ModelState =
  | { kind: 'checking' }
  | { kind: 'absent' }
  | { kind: 'downloading'; fraction: number }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

type ReanalyseState =
  | { kind: 'idle' }
  | { kind: 'running'; note: string; done: number; total: number }
  | { kind: 'done'; summary: string };

const SIZE_MB = Math.round(LAYOUT_MODEL.bytes / (1024 * 1024));
const SPEED_KEY = 'import.layout.ms';

const LAYOUT_MODES: { value: LayoutMode; label: string }[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'heuristic', label: 'Text layout only' },
];

/**
 * Settings section for the PDF layout model. Downloading it is what makes an
 * import mark tables, figures, captions and running heads, so the panel owns the
 * download, the one measurement that proves it runs here, and the re-analysis of
 * books imported before it arrived.
 */
export default function LayoutModelPanel() {
  const [state, setState] = useState<ModelState>({ kind: 'checking' });
  const [measuring, setMeasuring] = useState(false);
  const [measureError, setMeasureError] = useState<string | null>(null);
  const [greyed, setGreyed] = useState(0);
  const [reanalyse, setReanalyse] = useState<ReanalyseState>({ kind: 'idle' });
  const alive = useRef(true);
  const mode = useSetting<LayoutMode>('import.layout', 'auto');
  const speed = useSetting<number>(SPEED_KEY, 0);

  useEffect(() => {
    alive.current = true;
    void (async () => {
      const [ready, count] = await Promise.all([
        isLayoutModelReady(),
        db.books.filter((book) => book.format === 'pdf').count(),
      ]);
      if (!alive.current) return;
      setState(ready ? { kind: 'ready' } : { kind: 'absent' });
      setGreyed(count);
    })();
    return () => {
      alive.current = false;
    };
  }, []);

  const download = useCallback(async () => {
    setState({ kind: 'downloading', fraction: 0 });
    try {
      await downloadLayoutModel((fraction) => {
        if (alive.current) setState({ kind: 'downloading', fraction });
      });
      if (!alive.current) return;
      setState({ kind: 'ready' });
      // A download that cannot actually run the model is worth knowing about now,
      // not on the next import; the measurement is cheap on this page.
      void measure();
    } catch (error) {
      if (alive.current) setState({ kind: 'error', message: messageOf(error) });
    }
    // `measure` is stable; the dependency is only there for the linter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remove = useCallback(async () => {
    try {
      await deleteLayoutModel();
      if (!alive.current) return;
      setState({ kind: 'absent' });
      await setSetting(SPEED_KEY, 0);
    } catch (error) {
      if (alive.current) setState({ kind: 'error', message: messageOf(error) });
    }
  }, []);

  async function measure(): Promise<void> {
    setMeasuring(true);
    setMeasureError(null);
    try {
      const ms = await measureLayoutMs();
      await setSetting(SPEED_KEY, Math.round(ms));
    } catch (error) {
      setMeasureError(messageOf(error));
    } finally {
      if (alive.current) setMeasuring(false);
    }
  }

  const redoBooks = useCallback(async () => {
    const books = await db.books.filter((book) => book.format === 'pdf').toArray();
    if (!books.length) return;

    const totals: ReanalyseResult = {
      layout: 'heuristic',
      sentencesBefore: 0,
      sentencesAfter: 0,
      highlightsKept: 0,
      highlightsDropped: 0,
      bookmarksKept: 0,
      bookmarksMoved: 0,
      bookmarksDropped: 0,
      positionKept: true,
    };
    let modelBooks = 0;
    let failed = 0;

    for (let index = 0; index < books.length; index++) {
      const book = books[index];
      setReanalyse({ kind: 'running', note: book.title, done: index, total: books.length });
      try {
        const result = await reanalyseBook(book.id, (note) => {
          if (alive.current) setReanalyse({ kind: 'running', note: `${book.title} — ${note}`, done: index, total: books.length });
        });
        if (result.layout === 'model') modelBooks += 1;
        totals.sentencesBefore += result.sentencesBefore;
        totals.sentencesAfter += result.sentencesAfter;
        totals.highlightsKept += result.highlightsKept;
        totals.highlightsDropped += result.highlightsDropped;
        totals.bookmarksKept += result.bookmarksKept;
        totals.bookmarksMoved += result.bookmarksMoved;
        totals.bookmarksDropped += result.bookmarksDropped;
        totals.positionKept &&= result.positionKept;
      } catch {
        // One unreadable book must not stop the rest.
        failed += 1;
      }
    }

    if (!alive.current) return;
    setReanalyse({ kind: 'done', summary: describeRun(books.length, modelBooks, failed, totals) });
  }, []);

  if (state.kind === 'checking') {
    return (
      <div className={styles.panel}>
        <p className={styles.intro} role="status">
          Checking the layout model…
        </p>
      </div>
    );
  }

  const chip = chipFor(state);
  const busy = state.kind === 'downloading' || measuring;
  const speedLine = describeSpeed(speed);

  return (
    <div className={styles.panel}>
      <p className={styles.intro}>
        On-device AI. Detects tables, figures, captions and headers so they can be skipped when reading aloud.
        Applies to PDFs imported after download; use Re-analyse on older books.
      </p>

      <section className={styles.card} aria-labelledby="layout-model-title">
        <header className={styles.head}>
          <h3 id="layout-model-title" className={styles.title}>
            {LAYOUT_MODEL.label}
          </h3>
          <span className={styles.qualifier}>· {LAYOUT_MODEL.labels.length} region classes</span>
          <div className={styles.actions}>
            {state.kind !== 'ready' && (
              <button type="button" className="btn btn-primary" onClick={() => void download()} disabled={busy}>
                Download
              </button>
            )}
            {(state.kind === 'ready' || state.kind === 'error') && (
              <button type="button" className="btn btn-ghost" onClick={() => void remove()} disabled={busy}>
                Delete
              </button>
            )}
          </div>
        </header>

        <div className={styles.meta}>
          <span className={`${styles.status} ${styles[chip.tone] ?? ''}`.trim()} role="status" aria-live="polite">
            {chip.tone && <span className={styles.dot} aria-hidden="true" />}
            {chip.label}
          </span>
          <span className={styles.size}>~{SIZE_MB} MB · download once, then offline</span>
        </div>

        {state.kind === 'downloading' && (
          <div className={styles.download}>
            <div className="progress" aria-hidden="true">
              <span style={{ width: `${Math.round(state.fraction * 100)}%` }} />
            </div>
            <p className={styles.downloadText} role="status" aria-live="polite">
              {Math.round(state.fraction * SIZE_MB)} of {SIZE_MB} MB
            </p>
          </div>
        )}

        {state.kind === 'error' && (
          <div className="banner banner-error" role="alert">
            <div className={styles.errorBlock}>
              <p className={styles.errorStage}>The layout model is not working</p>
              <p className={styles.errorMessage}>{state.message}</p>
            </div>
          </div>
        )}

        <div className={styles.speed}>
          <p className={styles.speedResult}>
            {measureError ? (
              <span className={styles.measureError}>{measureError}</span>
            ) : speedLine ? (
              <>
                <span className={styles.speedValue}>{speedLine.value}</span>{' '}
                <span className={speedLine.ok ? styles.speedOk : styles.speedSlow}>{speedLine.verdict}</span>
              </>
            ) : (
              <span>Speed not measured yet</span>
            )}
          </p>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void measure()}
            disabled={busy || state.kind !== 'ready'}
          >
            {measuring ? 'Measuring…' : 'Measure speed'}
          </button>
        </div>

        <label className={styles.field}>
          <span className="field-label">Layout for new PDFs</span>
          <select
            className="input"
            value={mode}
            onChange={(event) => void setSetting('import.layout', event.target.value)}
          >
            {LAYOUT_MODES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className={styles.hint}>
            Automatic uses the model when it is downloaded. It runs on this device's CPU, page by page, and only on
            the pages where the text alone is unsure — a page with a table, or one laid out around a picture. It
            needs about 250 MB of free memory while it works.
          </span>
        </label>

        <div className={styles.redo}>
          <p className={styles.hint}>
            {greyed === 0
              ? 'No PDFs in the library yet.'
              : `${greyed} PDF${greyed === 1 ? '' : 's'} in the library were read with the layout they had at import time.`}
          </p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void redoBooks()}
            disabled={greyed === 0 || reanalyse.kind === 'running' || busy}
          >
            {reanalyse.kind === 'running'
              ? `Re-analysing ${reanalyse.done + 1} of ${reanalyse.total}`
              : `Re-analyse ${greyed} PDF${greyed === 1 ? '' : 's'}`}
          </button>
          {reanalyse.kind === 'running' && (
            <p className={styles.progressNote} role="status" aria-live="polite">
              {reanalyse.note}
            </p>
          )}
          {reanalyse.kind === 'done' && (
            <p className={styles.resultNote} role="status" aria-live="polite">
              {reanalyse.summary}
            </p>
          )}
        </div>

        <p className={styles.attribution}>
          {LAYOUT_MODEL.label} by PaddlePaddle — Apache-2.0. INT8 ONNX export by Ralutet.
        </p>
      </section>
    </div>
  );
}

/** The status chip: a word, a tone, and nothing the user has to interpret. */
function chipFor(state: ModelState): { label: string; tone: 'statusBusy' | 'statusReady' | 'statusError' | '' } {
  switch (state.kind) {
    case 'checking':
      return { label: 'Checking…', tone: 'statusBusy' };
    case 'absent':
      return { label: 'Not downloaded', tone: '' };
    case 'downloading':
      return { label: `Downloading ${Math.round(state.fraction * 100)}%`, tone: 'statusBusy' };
    case 'ready':
      return { label: 'Ready', tone: 'statusReady' };
    case 'error':
      return { label: 'Error', tone: 'statusError' };
  }
}

/** The measured number and whether an import will feel quick or slow. */
function describeSpeed(ms: number): { value: string; verdict: string; ok: boolean } | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const seconds = ms / 1000;
  return {
    value: `${Math.round(ms)} ms a page`,
    // Only the pages that carry a figure or a table are measured, so this is the
    // cost of one of those, not of the whole book.
    verdict:
      seconds < 1
        ? '✓ quick enough to run inside an import'
        : `about ${seconds.toFixed(1)} s for each page that needs it`,
    ok: seconds < 1,
  };
}

function describeRun(books: number, modelBooks: number, failed: number, totals: ReanalyseResult): string {
  const parts = [`Re-analysed ${books - failed} of ${books} PDF${books === 1 ? '' : 's'}`];
  parts.push(modelBooks === books - failed ? 'with the model' : `with the model on ${modelBooks}`);

  const kept = totals.highlightsKept;
  const dropped = totals.highlightsDropped;
  parts.push(
    dropped === 0
      ? `${kept} highlight${kept === 1 ? '' : 's'} carried across`
      : `${kept} highlight${kept === 1 ? '' : 's'} carried across, ${dropped} could not be found again and ${
          dropped === 1 ? 'was' : 'were'
        } removed`,
  );

  if (totals.bookmarksMoved > 0) {
    parts.push(`${totals.bookmarksMoved} bookmark${totals.bookmarksMoved === 1 ? '' : 's'} moved with the text`);
  }
  if (totals.bookmarksDropped > 0) {
    parts.push(`${totals.bookmarksDropped} bookmark${totals.bookmarksDropped === 1 ? '' : 's'} lost their chapter`);
  }
  if (!totals.positionKept) parts.push('one reading position was reset to the start of its chapter');
  if (failed > 0) parts.push(`${failed} could not be read`);

  return `${parts.join('; ')}.`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
