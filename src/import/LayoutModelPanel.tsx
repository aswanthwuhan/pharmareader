import { useCallback, useEffect, useRef, useState } from 'react';
import { db } from '../core/db';
import type { BookRecord } from '../core/types';
import { setSetting, useSetting, getSetting } from '../core/settings';
import { resetDownload, startDownload, useDownload, type DownloadState } from '../tts/downloads';
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

/** The layout-model download, shared by every mount of this panel. */
export const LAYOUT_DOWNLOAD_ID = 'layout';

/** What is on disk, independent of whether a download is running. */
type Availability = 'loading' | 'absent' | 'ready' | 'unsupported';

type ModelState =
  | { kind: 'loading' }
  | { kind: 'unsupported' }
  | { kind: 'absent' }
  | { kind: 'downloading'; fraction: number }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

type ReanalyseState =
  | { kind: 'idle' }
  | { kind: 'running'; note: string; done: number; total: number }
  | { kind: 'done'; summary: string };

/** What the panel needs of a PDF: never the parsed document or the file. */
type PdfBook = Pick<BookRecord, 'id' | 'title' | 'layout'>;

/**
 * Derive the card from the download store and the disk check, so a download that
 * outlived the panel is still shown as a download rather than as a failure.
 */
function panelState(
  download: DownloadState,
  available: Availability,
  failure: string | null,
): ModelState {
  if (available === 'unsupported') return { kind: 'unsupported' };
  if (download.status === 'downloading' || download.status === 'unpacking') {
    return { kind: 'downloading', fraction: download.fraction };
  }
  if (download.status === 'error') {
    return { kind: 'error', message: download.error ?? 'The download failed.' };
  }
  if (failure) return { kind: 'error', message: failure };
  if (download.status === 'done' || available === 'ready') return { kind: 'ready' };
  if (available === 'loading') return { kind: 'loading' };
  return { kind: 'absent' };
}

/** The weights live in Cache Storage; without it there is nothing to download to. */
function canStoreModel(): boolean {
  return typeof caches !== 'undefined';
}

async function listPdfs(): Promise<PdfBook[]> {
  const pdfs: PdfBook[] = [];
  await db.books
    .filter((book) => book.format === 'pdf')
    .each((book) => void pdfs.push({ id: book.id, title: book.title, layout: book.layout }));
  return pdfs;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

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
 *
 * The 32 MB download lives in the store (../tts/downloads), so leaving Settings
 * no longer loses it and returning shows the same progress.
 */
export default function LayoutModelPanel() {
  const download = useDownload(LAYOUT_DOWNLOAD_ID);
  const [available, setAvailable] = useState<Availability>('loading');
  const [failure, setFailure] = useState<string | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [measureError, setMeasureError] = useState<string | null>(null);
  const [pdfs, setPdfs] = useState<PdfBook[]>([]);
  const [reanalyse, setReanalyse] = useState<ReanalyseState>({ kind: 'idle' });
  const alive = useRef(true);
  // The measurement already started for the finished download this mount saw.
  const measured = useRef(false);
  const mode = useSetting<LayoutMode>('import.layout', 'auto');
  const speed = useSetting<number>(SPEED_KEY, 0);

  useEffect(() => {
    alive.current = true;
    void (async () => {
      const supported = canStoreModel();
      const [ready, books] = await Promise.all([
        supported ? isLayoutModelReady() : Promise.resolve(false),
        listPdfs(),
      ]);
      if (!alive.current) return;
      setAvailable(!supported ? 'unsupported' : ready ? 'ready' : 'absent');
      setPdfs(books);
    })();
    return () => {
      alive.current = false;
    };
  }, []);

  const startDownloadNow = useCallback(() => {
    setFailure(null);
    // The store keeps the download running when the panel unmounts; a second call
    // while it is in flight joins the same promise instead of fetching again.
    void startDownload(LAYOUT_DOWNLOAD_ID, async (report) => {
      await downloadLayoutModel((fraction) => report({ fraction }));
      // Read back inside the run: the weights have to sit where the importer looks
      // for them, and this failure has to be in the store so it survives the panel.
      if (!(await isLayoutModelReady())) {
        throw new Error('The layout model was downloaded but cannot be read back.');
      }
    });
  }, []);

  const remove = useCallback(async () => {
    try {
      await deleteLayoutModel();
      setFailure(null);
      setAvailable('absent');
      // Forget the finished download even if this panel is already gone: its state
      // would otherwise say Ready for files that were just deleted.
      resetDownload(LAYOUT_DOWNLOAD_ID);
      await setSetting(SPEED_KEY, 0);
    } catch (error) {
      if (alive.current) setFailure(messageOf(error));
    }
  }, []);

  const measure = useCallback(async (): Promise<void> => {
    setMeasuring(true);
    setMeasureError(null);
    try {
      const ms = await measureLayoutMs();
      await setSetting(SPEED_KEY, Math.round(ms));
    } catch (error) {
      if (alive.current) setMeasureError(messageOf(error));
    } finally {
      if (alive.current) setMeasuring(false);
    }
  }, []);

  // A download that cannot actually run the model is worth knowing about now, not
  // on the next import; the measurement is cheap on this page. A download that
  // finished while the panel was away is measured once, on return — the store's
  // `done` outlives the panel, so the stored speed is what stops a second run.
  useEffect(() => {
    if (download.status !== 'done' || measured.current) return;
    measured.current = true;
    void (async () => {
      if ((await getSetting(SPEED_KEY, 0)) > 0) return;
      await measure();
    })();
  }, [download.status, measure]);

  const state = panelState(download, available, failure);

  // What an import would do right now; a book read any other way is out of date.
  const wanted: BookRecord['layout'] = state.kind === 'ready' && mode === 'auto' ? 'model' : 'heuristic';
  const stale = pdfs.filter((book) => book.layout !== wanted);

  const redoBooks = async () => {
    // The out-of-date ones; when there are none, all of them, so a book can still
    // be re-read after an app update changed the layout rules.
    const books = stale.length ? stale : pdfs;
    if (!books.length) return;

    const totals: ReanalyseResult = {
      layout: 'heuristic',
      modelPages: 0,
      sentencesBefore: 0,
      sentencesAfter: 0,
      highlightsKept: 0,
      highlightsUnlinked: 0,
      bookmarksKept: 0,
      bookmarksMoved: 0,
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
        totals.highlightsUnlinked += result.highlightsUnlinked;
        totals.modelPages += result.modelPages;
        totals.bookmarksKept += result.bookmarksKept;
        totals.bookmarksMoved += result.bookmarksMoved;
        totals.positionKept &&= result.positionKept;
      } catch {
        // One unreadable book must not stop the rest.
        failed += 1;
      }
    }

    const after = await listPdfs();
    if (!alive.current) return;
    setPdfs(after);
    setReanalyse({ kind: 'done', summary: describeRun(books.length, modelBooks, failed, totals) });
  };

  if (state.kind === 'loading') {
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
      <div className={styles.block} role="group" aria-labelledby="layout-model-title">
        <header className={styles.head}>
          <h3 id="layout-model-title" className={styles.title}>
            {LAYOUT_MODEL.label}
          </h3>
          <div className={styles.actions}>
            {state.kind !== 'ready' && state.kind !== 'unsupported' && (
              <button type="button" className="btn btn-primary" onClick={() => startDownloadNow()} disabled={busy}>
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

        {state.kind === 'unsupported' && (
          <p className={styles.hint}>
            This browser cannot store the layout model, so PDFs are read with the text-only layout.
          </p>
        )}

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
          <span className={styles.hint}>Automatic uses the model where the text alone is unsure.</span>
        </label>
      </div>

      <details className="disc-sub">
        <summary>Advanced</summary>
        <div className="disc-sub-body">
          <div className={styles.advanced}>
            <p className={styles.hint}>{LAYOUT_MODEL.labels.length} region classes.</p>

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

            <div className={styles.redo}>
              <p className={styles.hint}>
                {pdfs.length === 0
                  ? 'No PDFs in the library yet.'
                  : stale.length === 0
                    ? `Every PDF in the library (${pdfs.length}) was read with the current layout setting.`
                    : `${stale.length} of ${plural(pdfs.length, 'PDF')} in the library ${
                        stale.length === 1 ? 'was' : 'were'
                      } not read with the current layout setting.`}
              </p>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void redoBooks()}
                disabled={pdfs.length === 0 || reanalyse.kind === 'running' || busy}
              >
                {reanalyse.kind === 'running'
                  ? `Re-analysing ${reanalyse.done + 1} of ${reanalyse.total}`
                  : stale.length
                    ? `Re-analyse ${plural(stale.length, 'PDF')}`
                    : `Re-analyse all ${plural(pdfs.length, 'PDF')} again`}
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
          </div>
        </div>
      </details>

      <details className="disc-sub">
        <summary>How this works</summary>
        <div className="disc-sub-body">
          <div className={styles.explain}>
            <p>
              On-device AI. Detects tables, figures, captions and headers so they can be skipped when reading
              aloud. Applies to PDFs imported after download; use Re-analyse on older books.
            </p>
            <p>
              The model runs on this device's CPU, page by page, and only on the pages where the text alone is
              unsure — a page with a table, or one laid out around a picture. It needs about 250 MB of free
              memory while it works.
            </p>
            <p>
              A book imported before the model arrived was read with the text layout only. Re-analysing reads it
              again here, on this device; highlights and bookmarks stay with the nearest text that is still
              there.
            </p>
            <p className={styles.attribution}>
              {LAYOUT_MODEL.label} by PaddlePaddle — Apache-2.0. INT8 ONNX export by Ralutet.
            </p>
          </div>
        </div>
      </details>
    </div>
  );
}

/** The status chip: a word, a tone, and nothing the user has to interpret. */
function chipFor(state: ModelState): { label: string; tone: 'statusBusy' | 'statusReady' | 'statusError' | '' } {
  switch (state.kind) {
    case 'loading':
      return { label: 'Checking…', tone: 'statusBusy' };
    case 'unsupported':
      return { label: 'Not available here', tone: '' };
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

export function describeRun(books: number, modelBooks: number, failed: number, totals: ReanalyseResult): string {
  const parts = [`Re-analysed ${books - failed} of ${plural(books, 'PDF')}`];
  // Say what ran, not what was hoped for: no model, or the model and how much it had to do.
  // A book whose detector dies mid-way is recorded as `heuristic`, but it did lay
  // out `modelPages` pages first (`pdf.ts`), so "the model was not used" would be
  // false there — only `modelPages === 0` proves it never ran.
  parts.push(
    modelBooks === 0
      ? totals.modelPages === 0
        ? 'with the text layout only; the model was not used'
        : `with the text layout only after the model stopped (it laid out ${plural(totals.modelPages, 'page')} first)`
      : `with the model on ${modelBooks} (it laid out ${plural(totals.modelPages, 'page')}; the rest were plain text)`,
  );

  const kept = totals.highlightsKept;
  const unlinked = totals.highlightsUnlinked;
  parts.push(
    unlinked === 0
      ? `${plural(kept, 'highlight')} carried across`
      : `${plural(kept, 'highlight')} carried across, ${unlinked} could not be found again and ${
          unlinked === 1 ? 'is' : 'are'
        } kept in your notes without a place in the text`,
  );

  if (totals.bookmarksMoved > 0) {
    parts.push(`${plural(totals.bookmarksMoved, 'bookmark')} moved to the nearest text that is still there`);
  }
  if (!totals.positionKept) parts.push('a reading position was moved to the nearest text that is still there');
  if (failed > 0) parts.push(`${failed} could not be read`);

  return `${parts.join('; ')}.`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
