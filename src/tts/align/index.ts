/**
 * Word timings for read-along word highlighting.
 *
 * The player asks for the times of the words it is about to speak; the reader
 * highlights the word whose span contains the audio position. With the Whisper
 * aligner installed, the clip is recognised on device and its words are matched
 * back to the sentence (`alignTimings`); otherwise, and whenever the aligner is
 * slower than the sentence is long, the proportional estimate is used so the
 * highlight never stalls.
 */
import { alignTimings } from './align';
import { estimateTimings } from './text';
import type { WordTiming } from './types';
import { isWhisperAvailable, isWhisperLoaded, resetWhisperWorker, transcribe } from './whisper';

export type { TranscriptWord, WordTiming } from './types';
export { alignTimings, transcriptFromChunks } from './align';
export { estimateTimings, words } from './text';

/** Recognised clips kept for replay: 200 sentences is a chapter's worth. */
const CACHE_LIMIT = 200;

const cache = new Map<string, WordTiming[]>();

/** True when the page cannot be seen (screen off, app in the background). */
function documentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/**
 * Key for the in-memory cache. The player replays the same Blob, but a reloaded
 * record comes back as a new object with the same bytes, so the size, the clip
 * length and the sentence identify it well enough.
 */
function cacheKey(audio: Blob, text: string, durationMs: number): string {
  return `${audio.size}:${Math.round(durationMs)}:${text}`;
}

function remember(key: string, timings: WordTiming[]): void {
  cache.delete(key);
  cache.set(key, timings);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/**
 * Test/settings hook: forget every recognised clip and everything in flight.
 * A reset while a clip is stuck would otherwise leave its timer (and, in tests,
 * its pending promise) behind.
 */
export function clearTimingCache(): void {
  cache.clear();
  if (waiting) {
    const job = waiting;
    waiting = null;
    settle(job, job.estimate);
  }
  if (running) {
    const job = running;
    running = null;
    settle(job, job.estimate);
  }
  consecutiveFailures = 0;
  backoffUntil = 0;
}

export function timingCacheSize(): number {
  return cache.size;
}

/**
 * How long the reader is willing to wait for a clip before falling back to the
 * estimate: four times its own length, and at least 4 s so the first clip of a
 * session also pays for loading the model.
 */
export function alignTimeoutMs(durationMs: number): number {
  return Math.max(4000, durationMs * 4);
}

/**
 * The recogniser runs one clip at a time, and the player asks for every clip it
 * plays (plus two ahead). Without a limit a model that is slower than the
 * playback keeps a growing queue of clips in the worker: every later request
 * times out, the highlight is always an estimate, and the worker's memory
 * climbs until it is killed. So: one clip in the model, at most one waiting
 * (the newest — the older one is no longer on screen and is answered with its
 * estimate), and a pause after a spell of timeouts or failures.
 */
interface AlignJob {
  audio: Blob;
  text: string;
  durationMs: number;
  key: string;
  estimate: WordTiming[];
  resolve: (timings: WordTiming[]) => void;
  /** The caller's budget; cleared as soon as the job is settled either way. */
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Settled by its timeout; a late model answer only refreshes the cache. */
  abandoned: boolean;
}

/** Consecutive timeouts or failures that mean the recogniser is not working. */
const FAILURE_BACKOFF_AFTER = 2;

/** How long the highlight runs on the estimate before the recogniser is tried again. */
const ALIGN_BACKOFF_MS = 60_000;

let running: AlignJob | null = null;
let waiting: AlignJob | null = null;
let consecutiveFailures = 0;
let backoffUntil = 0;

function settle(job: AlignJob, timings: WordTiming[]): void {
  if (job.abandoned) return;
  job.abandoned = true;
  if (job.timer !== undefined) {
    clearTimeout(job.timer);
    job.timer = undefined;
  }
  job.resolve(timings);
}

function start(job: AlignJob): void {
  running = job;
  const heard = transcribe(job.audio).then((result) => {
    const timings = alignTimings(job.text, result.words, job.durationMs);
    // Cache the late answer too: a clip that missed the budget is still worth
    // aligning when the player replays it (and the next sentence reuses the model).
    if (timings.length > 0) remember(job.key, timings);
    return timings;
  });
  const done = (timings: WordTiming[]): void => {
    // The model ran, so it is working: a transcript with no usable words is not
    // a failure, only a clip the estimate explains better.
    consecutiveFailures = 0;
    settle(job, timings.length > 0 ? timings : job.estimate);
    handOver(job);
  };
  const failed = (): void => {
    if (!job.abandoned) {
      consecutiveFailures += 1;
      settle(job, job.estimate);
      if (consecutiveFailures >= FAILURE_BACKOFF_AFTER) pauseAligning();
    }
    handOver(job);
  };
  heard.then(done, failed);
}

/** Let the waiting clip into the model, unless the pause started meanwhile. */
function handOver(job: AlignJob): void {
  if (running !== job) return;
  running = null;
  startWaiting();
}

function startWaiting(): void {
  const next = waiting;
  waiting = null;
  if (!next) return;
  if (next.abandoned) {
    startWaiting();
    return;
  }
  if (Date.now() < backoffUntil) {
    settle(next, next.estimate);
    return;
  }
  start(next);
}

function onTimeout(job: AlignJob): void {
  job.timer = undefined;
  if (waiting === job) waiting = null;
  job.abandoned = true;
  job.resolve(job.estimate);
  // A cold session pays for loading 42 MB of weights before the first clip can
  // be recognised, and that first wait is not the model being slow. Resetting
  // the worker now would only restart the load; do not count it.
  if (!isWhisperLoaded()) return;
  consecutiveFailures += 1;
  if (consecutiveFailures >= FAILURE_BACKOFF_AFTER) pauseAligning();
}

/**
 * The recogniser has fallen behind or is failing: stop feeding it and drop the
 * worker, whose queue and ONNX memory are exactly what has grown. The next clip
 * after the pause loads a fresh one.
 */
function pauseAligning(): void {
  backoffUntil = Date.now() + ALIGN_BACKOFF_MS;
  consecutiveFailures = 0;
  running = null;
  if (waiting) {
    const job = waiting;
    waiting = null;
    settle(job, job.estimate);
  }
  resetWhisperWorker();
}

/**
 * Timings for one synthesized clip of `text`.
 *
 * `audio` is the clip the player holds and `durationMs` its length. `charStart`/
 * `charEnd` index `text` as given, so a caller that passes the lexicon-expanded
 * sentence (what was actually spoken) can map the offsets back with its own
 * `charMap`. The result covers every word of `text`, is monotonic and stays
 * inside the clip.
 */
export async function wordTimings(audio: Blob, text: string, durationMs: number): Promise<WordTiming[]> {
  const estimate = estimateTimings(text, durationMs);
  if (audio.size === 0 || durationMs <= 0 || text.trim() === '') return estimate;

  const key = cacheKey(audio, text, durationMs);
  const cached = cache.get(key);
  if (cached) {
    // Least-recently-used goes to the back.
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  // A spell of timeouts means the recogniser cannot keep up right now; asking
  // again would only rebuild the backlog, so the highlight runs on the estimate
  // for a while.
  if (Date.now() < backoffUntil) return estimate;
  // Screen off or the app in the background: nobody is looking at the
  // highlight, and a recogniser pass is the most expensive thing on the phone.
  // The proportional estimate reads no worse than nothing until it is seen.
  if (documentHidden()) return estimate;
  if (!(await isWhisperAvailable())) return estimate;

  return new Promise<WordTiming[]>((resolve) => {
    const job: AlignJob = {
      audio,
      text,
      durationMs,
      key,
      estimate,
      resolve,
      timer: undefined,
      abandoned: false,
    };
    job.timer = setTimeout(() => onTimeout(job), alignTimeoutMs(durationMs));
    if (running) {
      // Newest wins: a newer request means the waiting clip is no longer the
      // sentence being read.
      if (waiting) settle(waiting, waiting.estimate);
      waiting = job;
    } else {
      start(job);
    }
  });
}
