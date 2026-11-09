/**
 * The aligner's link to its worker.
 *
 * Three things make this more than a `postMessage` wrapper:
 * - the model must be *loaded* before the first clip, so a caller can warm it
 *   up (`prepareWhisper`) and the panel can show download progress;
 * - the worker does not survive a reload, so "are the weights on disk?" is
 *   answered by the cache (`isWhisperAvailable`), the same way the voice engines
 *   answer it;
 * - a failed load must be retryable — otherwise one flaky download would keep
 *   word highlighting off until the app restarts.
 */
import { alignError } from './alignError';
import { decodeToMono16k, WHISPER_SAMPLE_RATE } from './decode';
import type { TranscriptWord } from './types';
import type { WhisperRequest, WhisperResponse } from './whisperProtocol';
import { deleteWhisperFiles, isWhisperDownloaded, setWhisperReady } from './whisperModel';

export interface WhisperResult {
  words: TranscriptWord[];
  /** The whole transcript as one string (what the recogniser heard). */
  text: string;
  /** Time inside the model, in ms. */
  ms: number;
}

interface PendingRequest {
  resolve: (result: WhisperResult) => void;
  reject: (err: Error) => void;
}

let worker: Worker | null = null;
let ready = false;
let loading: Promise<void> | null = null;
let pendingInit: { resolve: () => void; reject: (err: Error) => void } | null = null;
const pending = new Map<number, PendingRequest>();
let nextId = 1;
let onProgress: ((fraction: number) => void) | undefined;
/** Cached answer of "are the weights on disk?"; cleared by delete/prepare. */
let downloaded: boolean | undefined;

/** A Web Worker is required; the aligner is not attempted on the main thread. */
export function hasWhisperSupport(): boolean {
  return typeof Worker !== 'undefined';
}

/** Weights present and complete (or loaded once already) — no download needed. */
export async function isWhisperAvailable(): Promise<boolean> {
  if (!hasWhisperSupport()) return false;
  if (downloaded !== undefined) return downloaded;
  downloaded = await isWhisperDownloaded();
  return downloaded;
}

export function isWhisperLoaded(): boolean {
  return ready;
}

/** Download (if needed) and load the model. Safe to call repeatedly. */
export async function prepareWhisper(progress?: (fraction: number) => void): Promise<void> {
  if (ready) {
    progress?.(1);
    return;
  }
  const attempt = (loading ??= init(progress));
  try {
    await attempt;
  } catch (err) {
    if (loading === attempt) loading = null;
    throw err;
  }
}

async function init(progress?: (fraction: number) => void): Promise<void> {
  onProgress = progress;
  try {
    const scope = ensureWorker();
    const loaded = new Promise<void>((resolve, reject) => {
      pendingInit = { resolve, reject };
    });
    scope.postMessage({ type: 'init' } satisfies WhisperRequest);
    await loaded;
    ready = true;
    downloaded = true;
    progress?.(1);
    await setWhisperReady(true);
  } catch (err) {
    throw alignError('files', err);
  } finally {
    // Do not retain the panel's callback once the download is over.
    onProgress = undefined;
  }
}

/**
 * Recognise the words of `audio` with their times. Throws `AlignError`; callers
 * that can live with an estimate are expected to fall back instead of failing.
 */
export async function transcribe(audio: Blob): Promise<WhisperResult> {
  await prepareWhisper();
  let pcm: Float32Array;
  try {
    pcm = await decodeToMono16k(audio);
  } catch (err) {
    throw alignError('decode', err);
  }
  if (pcm.length === 0) throw alignError('decode', new Error('The clip could not be decoded'));
  return request(pcm);
}

/** Wall time of decode + model, for the panel's speed test. */
export async function measureWhisper(audio: Blob): Promise<WhisperResult & { wallMs: number }> {
  const started = performance.now();
  const result = await transcribe(audio);
  return { ...result, wallMs: performance.now() - started };
}

/** Drop the loaded model (the panel calls this after deleting the download). */
export function resetWhisperWorker(): void {
  ready = false;
  loading = null;
  pendingInit?.reject(new Error('The aligner was reset'));
  pendingInit = null;
  rejectPending(new Error('The aligner was reset'));
  worker?.terminate();
  worker = null;
  downloaded = undefined;
}

/** Delete the cached weights and unload the model. */
export async function deleteWhisperModel(): Promise<void> {
  resetWhisperWorker();
  await deleteWhisperFiles();
  downloaded = false;
}

function ensureWorker(): Worker {
  if (worker) return worker;
  if (!hasWhisperSupport()) {
    throw alignError('worker', new Error('This browser cannot run a background worker'));
  }
  // Vite turns this into a bundled module worker.
  const created = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' });
  created.onmessage = (event: MessageEvent<WhisperResponse>) => receive(event.data);
  created.onerror = (event) => fail(new Error(event.message || 'The aligner worker failed'));
  created.onmessageerror = () => fail(new Error('The aligner worker sent an unreadable message'));
  worker = created;
  return created;
}

function fail(err: Error): void {
  ready = false;
  loading = null;
  pendingInit?.reject(err);
  pendingInit = null;
  rejectPending(err);
  worker?.terminate();
  worker = null;
}

function rejectPending(err: Error): void {
  for (const request of pending.values()) request.reject(err);
  pending.clear();
}

function receive(message: WhisperResponse): void {
  switch (message.type) {
    case 'progress':
      onProgress?.(message.fraction);
      return;
    case 'ready':
      pendingInit?.resolve();
      pendingInit = null;
      return;
    case 'result': {
      const request = pending.get(message.id);
      pending.delete(message.id);
      request?.resolve({ words: message.words, text: message.text, ms: message.ms });
      return;
    }
    case 'error': {
      const err = new Error(message.message);
      if (message.id === undefined) {
        ready = false;
        loading = null;
        pendingInit?.reject(err);
        pendingInit = null;
        rejectPending(err);
      } else {
        pending.get(message.id)?.reject(err);
        pending.delete(message.id);
      }
      return;
    }
  }
}

function request(pcm: Float32Array): Promise<WhisperResult> {
  const scope = ensureWorker();
  const id = nextId++;
  return new Promise<WhisperResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    scope.postMessage(
      { type: 'align', id, audio: pcm, sampleRate: WHISPER_SAMPLE_RATE } satisfies WhisperRequest,
      [pcm.buffer as ArrayBuffer]
    );
  });
}
