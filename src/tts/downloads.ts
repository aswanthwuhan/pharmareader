/**
 * Download progress for the on-device models, held outside React.
 *
 * A model download is 42–334 MB and takes minutes, but the Settings panel that
 * started it is unmounted the moment the user browses to another screen (the
 * phone reported "the progress is lost and it says download error"). The engine
 * kept downloading; the panel's React state did not survive, so on return it saw
 * an unfinished cache and either offered the download again or, for the native
 * Kokoro plugin, got a second `download()` rejected with BUSY.
 *
 * This module is the single owner of that state. The download runs in a plain
 * promise that no component can cancel by unmounting; panels subscribe and only
 * render what the store says. A second `startDownload` while one is running
 * returns the SAME promise, so a remount joins the download instead of starting
 * another one — no BUSY, no duplicate fetch, no lost progress.
 */
import { useCallback, useSyncExternalStore } from 'react';

/**
 * `unpacking` covers everything after the bytes have arrived (unpacking the
 * native archive, loading the weights into memory): still work the user waits
 * for, still shown as a download in progress.
 */
export type DownloadStatus = 'idle' | 'downloading' | 'unpacking' | 'done' | 'error';

/** Which step of the download a state belongs to (the wording stays in the panels). */
export type DownloadStage = 'download' | 'unpack' | 'load';

export interface DownloadState {
  status: DownloadStatus;
  /** 0..1 of the bytes received, monotonic within a run; kept on failure so the UI can resume. */
  fraction: number;
  stage: DownloadStage;
  /** One-line message, set only when `status` is `'error'`. */
  error?: string;
  /** The original rejection, so the panels keep their existing diagnostics. */
  cause?: unknown;
}

export interface DownloadUpdate {
  /** New fraction, 0..1. Omit to only change the stage. */
  fraction?: number;
  /** New stage. Omit to keep the current one. */
  stage?: DownloadStage;
}

/** Reports progress from inside a `startDownload` run. */
export type DownloadReporter = (update: DownloadUpdate) => void;

const IDLE: DownloadState = { status: 'idle', fraction: 0, stage: 'download' };

const states = new Map<string, DownloadState>();
const listeners = new Map<string, Set<() => void>>();
const running = new Map<string, Promise<void>>();

function emit(id: string): void {
  const set = listeners.get(id);
  if (!set) return;
  for (const listener of [...set]) {
    try {
      listener();
    } catch {
      // A broken subscriber must not break the download it was watching.
    }
  }
}

function setState(id: string, next: DownloadState): void {
  states.set(id, next);
  emit(id);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function messageOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err.length > 0) return err;
  return 'The download failed.';
}

/** The current state for `id`; a stable object, as `useSyncExternalStore` requires. */
export function getDownload(id: string): DownloadState {
  return states.get(id) ?? IDLE;
}

/** Whether a download for `id` is running (started by this module, not cancelled). */
export function isDownloadRunning(id: string): boolean {
  return running.has(id);
}

/**
 * Watch one model's download. The callback runs on every change, including one
 * made before it subscribed (the caller then reads `getDownload`).
 */
export function subscribe(id: string, onChange: () => void): () => void {
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
  }
  set.add(onChange);
  return () => {
    set.delete(onChange);
    if (set.size === 0) listeners.delete(id);
  };
}

/**
 * Run `run` once per model, independent of any component.
 *
 * The returned promise never rejects: a failure is recorded as `status: 'error'`
 * with the message and the original error, which is what a remounted panel has
 * to show. Starting again while the first run is in flight returns its promise.
 */
export function startDownload(
  id: string,
  run: (report: DownloadReporter) => Promise<void>
): Promise<void> {
  const inFlight = running.get(id);
  if (inFlight) return inFlight;

  setState(id, { status: 'downloading', fraction: 0, stage: 'download' });

  // Started on a microtask so `running` is set before `run` executes: a run that
  // throws synchronously must still be cleaned up, and a subscribe from inside
  // `run` must already see the entry as running.
  const task = Promise.resolve()
    .then(async () => {
      const report: DownloadReporter = (update) => {
        const current = states.get(id);
        // Progress can arrive after a run ended (a late event from a plugin): only
        // a run in flight may move the state.
        if (!current || (current.status !== 'downloading' && current.status !== 'unpacking')) return;
        const stage = update.stage ?? current.stage;
        const fraction =
          update.fraction === undefined
            ? current.fraction
            : Math.max(current.fraction, clamp01(update.fraction));
        const status = stage === 'download' ? 'downloading' : 'unpacking';
        if (stage === current.stage && fraction === current.fraction) return;
        setState(id, { status, fraction, stage });
      };

      try {
        await run(report);
        setState(id, { status: 'done', fraction: 1, stage: 'load' });
      } catch (err) {
        const last = getDownload(id);
        setState(id, {
          status: 'error',
          fraction: last.fraction,
          stage: last.stage,
          error: messageOf(err),
          cause: err,
        });
      } finally {
        running.delete(id);
      }
    })
    .catch(() => undefined);

  running.set(id, task);
  return task;
}

/**
 * Forget a finished download (after the model was deleted). Never touches a run
 * in flight: the files it is writing must not be reported as gone.
 */
export function resetDownload(id: string): void {
  if (running.has(id)) return;
  states.delete(id);
  emit(id);
}

/** Subscribe a component to one model's download. */
export function useDownload(id: string): DownloadState {
  const subscribeToId = useCallback((onChange: () => void) => subscribe(id, onChange), [id]);
  const snapshot = useCallback(() => getDownload(id), [id]);
  return useSyncExternalStore(subscribeToId, snapshot, snapshot);
}
