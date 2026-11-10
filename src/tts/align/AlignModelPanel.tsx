import { useCallback, useEffect, useRef, useState } from 'react';
import { db } from '../../core/db';
import { setSetting, useSetting } from '../../core/settings';
import { resetDownload, startDownload, useDownload, type DownloadState } from '../downloads';
import { copyText } from '../neural/clipboard';
import { describeAlignError, type AlignErrorInfo } from './alignError';
import styles from './AlignModelPanel.module.css';
import { WHISPER_SIZE_MB } from './size';
import {
  deleteWhisperModel,
  hasWhisperSupport,
  isWhisperAvailable,
  measureWhisper,
  prepareWhisper,
  resetWhisperWorker,
} from './whisper';

/** Last measured speed: model time, end-to-end time, and the clip it ran on. */
export const WHISPER_SPEED_SETTING = 'align.whisper.speed';

/** The aligner download, shared by every mount of this panel. */
export const WHISPER_DOWNLOAD_ID = 'whisper';

interface SpeedRecord {
  modelMs: number;
  wallMs: number;
  clipMs: number;
  words: number;
  at: number;
}

/** What is on disk, independent of whether a download is running. */
type Availability = 'loading' | 'unsupported' | 'absent' | 'ready';

type PanelState =
  | { kind: 'loading' }
  | { kind: 'unsupported' }
  | { kind: 'absent' }
  | { kind: 'downloading'; fraction: number }
  | { kind: 'ready' }
  | { kind: 'error'; info: AlignErrorInfo };

/**
 * Derive the card from the download store and the disk check, so a download that
 * outlived the panel is still shown as a download rather than as a failure.
 */
function panelState(
  download: DownloadState,
  available: Availability,
  failure: AlignErrorInfo | null
): PanelState {
  if (available === 'unsupported') return { kind: 'unsupported' };
  if (download.status === 'downloading' || download.status === 'unpacking') {
    return { kind: 'downloading', fraction: download.fraction };
  }
  if (download.status === 'error') {
    return {
      kind: 'error',
      info: describeAlignError(download.cause ?? download.error ?? 'The download failed.'),
    };
  }
  if (failure) return { kind: 'error', info: failure };
  if (download.status === 'done' || available === 'ready') return { kind: 'ready' };
  if (available === 'loading') return { kind: 'loading' };
  return { kind: 'absent' };
}

/**
 * Settings card for the on-device aligner.
 *
 * The word highlighting works without it (proportional estimate), so this card
 * has to make one thing obvious: what installing it buys, and how much it costs
 * to download and run. The 42 MB download lives in the store (../downloads), so
 * leaving Settings no longer loses it and returning shows the same progress.
 */
export default function AlignModelPanel() {
  const download = useDownload(WHISPER_DOWNLOAD_ID);
  const [available, setAvailable] = useState<Availability>('loading');
  const [failure, setFailure] = useState<AlignErrorInfo | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [measureError, setMeasureError] = useState<string | null>(null);
  const speed = useSetting<SpeedRecord | null>(WHISPER_SPEED_SETTING, null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!hasWhisperSupport()) {
        if (alive) setAvailable('unsupported');
        return;
      }
      const ready = await isWhisperAvailable();
      if (alive) setAvailable(ready ? 'ready' : 'absent');
    })();
    return () => {
      alive = false;
    };
  }, []);

  const startDownloadNow = useCallback(() => {
    setFailure(null);
    // The store keeps the download running when the panel unmounts; a second call
    // while it is in flight joins the same promise instead of fetching again.
    void startDownload(WHISPER_DOWNLOAD_ID, async (report) => {
      await prepareWhisper((fraction) => report({ fraction }));
    });
  }, []);

  const remove = useCallback(async () => {
    try {
      // Unload first: an open worker keeps the cached weights reachable and some
      // browsers refuse the delete while it holds them.
      resetWhisperWorker();
      await deleteWhisperModel();
      setFailure(null);
      setAvailable('absent');
      resetDownload(WHISPER_DOWNLOAD_ID);
    } catch (err) {
      setFailure(describeAlignError(err));
    }
  }, []);

  /**
   * Speed is measured on the most recent real clip: synthesising a test
   * sentence here would need a voice engine, and a silent clip would measure
   * the decoder on nothing.
   */
  const measure = useCallback(async () => {
    setMeasuring(true);
    setMeasureError(null);
    try {
      const clip = await latestClip();
      if (!clip) {
        setMeasureError('No clip in the cache yet — play one sentence, then measure again.');
        return;
      }
      const result = await measureWhisper(clip.audio);
      await setSetting(WHISPER_SPEED_SETTING, {
        modelMs: Math.round(result.ms),
        wallMs: Math.round(result.wallMs),
        clipMs: Math.round(clip.durationMs),
        words: result.words.length,
        at: Date.now(),
      });
    } catch (err) {
      const info = describeAlignError(err);
      setMeasureError(`Failed while ${info.stage}: ${info.message}`);
    } finally {
      setMeasuring(false);
    }
  }, []);

  const state = panelState(download, available, failure);
  const busy = state.kind === 'downloading' || measuring;
  const chip = chipFor(state);

  return (
    <section className={styles.block} aria-labelledby="align-whisper-title">
      <header className={styles.head}>
        <h3 id="align-whisper-title" className={styles.title}>
          Word-by-word highlighting
        </h3>
        <span className={styles.qualifier}>· on-device Whisper, English</span>
        <div className={styles.actions}>
          {state.kind !== 'ready' && state.kind !== 'unsupported' && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => startDownloadNow()}
              disabled={busy || state.kind === 'loading'}
            >
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
        <span className={chip.tone ? `status-chip ${chip.tone}` : 'status-chip'} role="status" aria-live="polite">
          <span className="status-dot" aria-hidden="true" />
          {chip.label}
        </span>
        <span className={styles.size}>~{WHISPER_SIZE_MB} MB · use Wi-Fi</span>
      </div>

      {state.kind === 'unsupported' && (
        <p className={styles.hint}>
          This browser cannot run the on-device aligner, so words are highlighted by an estimate.
        </p>
      )}

      {state.kind === 'downloading' && (
        <div className={styles.download}>
          <div className="progress" aria-hidden="true">
            <span style={{ width: `${Math.round(state.fraction * 100)}%` }} />
          </div>
          <p className={styles.downloadText} role="status" aria-live="polite">
            {Math.round(state.fraction * WHISPER_SIZE_MB)} of {WHISPER_SIZE_MB} MB
          </p>
        </div>
      )}

      {state.kind === 'error' && <ErrorDetails info={state.info} />}

      {/* Measuring lives under Advanced, but a failed measurement is the answer
          to the tap, so it stays in the open next to the model it belongs to. */}
      {measureError && (
        <p className={styles.measureError} role="alert">
          {measureError}
        </p>
      )}

      <details className="disc-sub">
        <summary>Advanced</summary>
        <div className="disc-sub-body">
          <div className={styles.speed}>
            <p className={styles.speedResult}>
              {speed ? <SpeedLine speed={speed} /> : <span>Speed not measured yet</span>}
            </p>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void measure()}
              // Measuring runs the real model, so it must already be here.
              disabled={busy || state.kind !== 'ready'}
            >
              {measuring ? 'Measuring…' : 'Measure speed'}
            </button>
          </div>

          <p className={styles.attribution}>
            Whisper by OpenAI — MIT licence. ONNX export: onnx-community/whisper-tiny.en_timestamped
            (q8).
          </p>
        </div>
      </details>

      <details className="disc-sub">
        <summary>How this works</summary>
        <div className="disc-sub-body">
          <p className={styles.intro}>
            Words are highlighted as they are spoken. Without this model the timing is an estimate from
            each word&apos;s length, which drifts on long drug names and pauses.
          </p>
        </div>
      </details>
    </section>
  );
}

function chipFor(state: PanelState): { label: string; tone: string } {
  switch (state.kind) {
    case 'loading':
      return { label: 'Checking…', tone: 'is-busy' };
    case 'unsupported':
      return { label: 'Not available here', tone: '' };
    case 'absent':
      return { label: 'Not downloaded', tone: '' };
    case 'downloading':
      return { label: `Downloading ${Math.round(state.fraction * 100)}%`, tone: 'is-busy' };
    case 'ready':
      return { label: 'Ready', tone: 'is-ready' };
    case 'error':
      return { label: 'Error', tone: 'is-error' };
  }
}

/** "≈ 620 ms for a 4.2 s clip · 7× faster than speech". */
function SpeedLine({ speed }: { speed: SpeedRecord }) {
  const clipSeconds = speed.clipMs / 1000;
  // How much faster than the audio itself the aligner is: 1 means real time.
  const ratio = speed.modelMs > 0 && speed.clipMs > 0 ? speed.clipMs / speed.modelMs : 0;
  const verdict =
    ratio === 0
      ? 'speed unknown'
      : ratio >= 1
        ? `${ratio.toFixed(1)}× faster than speech`
        : `${(1 / ratio).toFixed(1)}× slower than speech`;
  return (
    <>
      <span className={styles.speedValue}>
        ≈ {speed.modelMs} ms for a {clipSeconds.toFixed(1)} s clip
      </span>{' '}
      <span className={ratio >= 1 ? styles.speedOk : styles.speedSlow}>
        {verdict} · {speed.words} words
      </span>
    </>
  );
}

function ErrorDetails({ info }: { info: AlignErrorInfo }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const detailsRef = useRef<HTMLPreElement>(null);
  const blockRef = useRef<HTMLDivElement>(null);

  const copy = useCallback(() => {
    void copyText(info.details).then((ok) => {
      setCopyState(ok ? 'copied' : 'failed');
      if (!ok) selectDetails(blockRef.current, detailsRef.current);
      window.setTimeout(() => setCopyState('idle'), 2500);
    });
  }, [info.details]);

  return (
    <div className="banner banner-error" role="alert">
      <div className={styles.errorBlock} ref={blockRef}>
        <p className={styles.errorStage}>Failed while {info.stage}</p>
        <p className={styles.errorMessage}>{info.message}</p>
        <details className={`disc-sub ${styles.errorDetails}`} open={copyState === 'failed'}>
          <summary>Technical details</summary>
          <pre ref={detailsRef}>{info.details}</pre>
        </details>
        <button type="button" className={`btn btn-ghost ${styles.copyError}`} onClick={copy}>
          {copyState === 'copied'
            ? 'Copied'
            : copyState === 'failed'
              ? 'Copy blocked — text selected, press and hold to copy'
              : 'Copy error details'}
        </button>
      </div>
    </div>
  );
}

/** When a WebView refuses the clipboard, leave the text selected to long-press. */
function selectDetails(block: HTMLDivElement | null, pre: HTMLPreElement | null): void {
  if (!block || !pre || typeof window.getSelection !== 'function') return;
  const range = document.createRange();
  range.selectNodeContents(pre);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** The most recent cached clip, the one the user just listened to. */
async function latestClip(): Promise<{ audio: Blob; durationMs: number } | null> {
  try {
    const record = await db.audioCache.orderBy('createdAt').last();
    if (!record || record.audio.size === 0) return null;
    return { audio: record.audio, durationMs: record.durationMs };
  } catch {
    // IndexedDB unavailable (private mode): the test simply cannot run.
    return null;
  }
}
