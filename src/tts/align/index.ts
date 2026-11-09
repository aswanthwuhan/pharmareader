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
import { isWhisperAvailable, transcribe } from './whisper';

export type { TranscriptWord, WordTiming } from './types';
export { alignTimings, transcriptFromChunks } from './align';
export { estimateTimings, words } from './text';

/** Recognised clips kept for replay: 200 sentences is a chapter's worth. */
const CACHE_LIMIT = 200;

const cache = new Map<string, WordTiming[]>();

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

/** Test/settings hook: forget every recognised clip. */
export function clearTimingCache(): void {
  cache.clear();
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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The aligner took too long')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
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

  if (!(await isWhisperAvailable())) return estimate;

  const heard = transcribe(audio).then((result) => alignTimings(text, result.words, durationMs));
  // Cache the late answer too: a clip that missed the budget is still worth
  // aligning when the player replays it (and the next sentence reuses the model).
  heard.then(
    (timings) => {
      if (timings.length > 0) remember(key, timings);
    },
    () => undefined
  );

  try {
    const timings = await withTimeout(heard, alignTimeoutMs(durationMs));
    if (timings.length > 0) return timings;
  } catch {
    // Timeout or failure: the estimate keeps the highlight moving.
  }
  return estimate;
}
