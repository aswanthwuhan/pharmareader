import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alignTimeoutMs, clearTimingCache, estimateTimings, timingCacheSize, wordTimings } from './index';
import type { TranscriptWord } from './types';

/** The aligner's worker client, replaced by a scriptable recogniser. */
const aligner = vi.hoisted(() => ({
  available: false,
  loaded: false,
  fail: false,
  hang: false,
  calls: 0,
  resets: 0,
  words: [] as TranscriptWord[],
}));

vi.mock('./whisper', () => ({
  isWhisperAvailable: () => Promise.resolve(aligner.available),
  isWhisperLoaded: () => aligner.loaded,
  resetWhisperWorker: () => {
    aligner.resets++;
  },
  transcribe: () => {
    aligner.calls++;
    if (aligner.hang) return new Promise(() => undefined);
    if (aligner.fail) return Promise.reject(new Error('decoder blew up'));
    return Promise.resolve({ words: aligner.words, text: '', ms: 120 });
  },
}));

/** What the browser can run; false stands for iOS 15.4–16.3. */
const caps = vi.hoisted(() => ({ supported: true }));
vi.mock('../capabilities', () => ({ supportsNeuralVoices: () => caps.supported }));

function clip(bytes = 4000): Blob {
  return new Blob([new Uint8Array(bytes)]);
}

const TEXT = 'Digoxin has a half-life';

beforeEach(() => {
  clearTimingCache();
  caps.supported = true;
  aligner.available = false;
  aligner.loaded = false;
  aligner.fail = false;
  aligner.hang = false;
  aligner.calls = 0;
  aligner.resets = 0;
  aligner.words = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('estimateTimings', () => {
  it('covers every word and fills the clip', () => {
    const timings = estimateTimings(TEXT, 2000);
    expect(timings.map((timing) => timing.charStart)).toEqual([0, 8, 12, 14]);
    expect(timings[0]!.startMs).toBe(0);
    expect(timings.at(-1)!.endMs).toBeCloseTo(2000);
    // "Digoxin" is longer than "a", and takes longer.
    expect(timings[0]!.endMs - timings[0]!.startMs).toBeGreaterThan(timings[2]!.endMs - timings[2]!.startMs);
  });

  it('times a word by its spoken length and keeps inside the speech', () => {
    // "CYP3A4" is said as "C Y P three eigh four": 21 characters, not 6.
    const timings = estimateTimings('The CYP3A4 enzyme', 3000, { weights: [3, 21, 6], startMs: 300, endMs: 2500 });
    expect(timings[0]!.startMs).toBe(300);
    expect(timings.at(-1)!.endMs).toBeCloseTo(2500);
    expect(timings[1]!.endMs - timings[1]!.startMs).toBeCloseTo((22 / 33) * 2200);
  });

  it('ignores a speech window with no room in it', () => {
    const timings = estimateTimings('one two', 1000, { startMs: 400, endMs: 400 });
    expect(timings[0]!.startMs).toBe(0);
    expect(timings.at(-1)!.endMs).toBeCloseTo(1000);
  });
});

describe('wordTimings', () => {
  it('estimates without the aligner, and does not touch the worker', async () => {
    const timings = await wordTimings(clip(), TEXT, 2000);
    expect(timings).toEqual(estimateTimings(TEXT, 2000));
    expect(aligner.calls).toBe(0);
    expect(timingCacheSize()).toBe(0);
  });

  it('estimates an empty sentence and an empty clip without asking the model', async () => {
    aligner.available = true;
    expect(await wordTimings(clip(), '   ', 2000)).toEqual([]);
    expect(await wordTimings(clip(0), TEXT, 2000)).toEqual(estimateTimings(TEXT, 2000));
    expect(aligner.calls).toBe(0);
  });

  it('stays on the estimate when the browser cannot run the aligner at all', async () => {
    // iOS 15.4–16.3: the weights could be downloaded but the SIMD-only worker
    // would fail on the first clip, so it must not even be asked.
    caps.supported = false;
    aligner.available = true;
    expect(await wordTimings(clip(), TEXT, 2000)).toEqual(estimateTimings(TEXT, 2000));
    expect(aligner.calls).toBe(0);
    expect(timingCacheSize()).toBe(0);
  });

  it('estimates while the page cannot be seen, so nothing runs behind a dark screen', async () => {
    aligner.available = true;
    const own = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      const timings = await wordTimings(clip(), TEXT, 2000);

      expect(timings).toEqual(estimateTimings(TEXT, 2000));
      expect(aligner.calls).toBe(0);
      // Not cached either: a real pass can still run when the screen comes back.
      expect(timingCacheSize()).toBe(0);
    } finally {
      if (own) Object.defineProperty(document, 'visibilityState', own);
      else delete (document as unknown as Record<string, unknown>).visibilityState;
    }
  });

  it('asks the model again once the page is visible', async () => {
    aligner.available = true;
    aligner.words = [
      { text: 'Digoxin', startMs: 0, endMs: 500 },
      { text: 'has', startMs: 500, endMs: 700 },
      { text: 'a', startMs: 700, endMs: 780 },
      { text: 'half', startMs: 780, endMs: 1050 },
      { text: 'life', startMs: 1050, endMs: 1400 },
    ];
    expect(document.visibilityState).not.toBe('hidden');

    await wordTimings(clip(), TEXT, 2600);

    expect(aligner.calls).toBe(1);
  });

  it('uses the recogniser when the model is installed', async () => {
    aligner.available = true;
    aligner.words = [
      { text: 'Digoxin', startMs: 0, endMs: 500 },
      { text: 'has', startMs: 500, endMs: 700 },
      { text: 'a', startMs: 700, endMs: 780 },
      { text: 'half', startMs: 780, endMs: 1050 },
      { text: 'life', startMs: 1050, endMs: 1400 },
    ];

    const timings = await wordTimings(clip(), TEXT, 2600);

    expect(aligner.calls).toBe(1);
    expect(timings[0]).toMatchObject({ charStart: 0, startMs: 0, endMs: 500 });
    expect(timings[3]).toMatchObject({ charStart: 14, startMs: 780, endMs: 1400 });
  });

  it('answers a replay from memory instead of the model', async () => {
    aligner.available = true;
    aligner.words = [
      { text: 'Digoxin', startMs: 0, endMs: 500 },
      { text: 'has', startMs: 500, endMs: 700 },
      { text: 'a', startMs: 700, endMs: 780 },
      { text: 'half', startMs: 780, endMs: 1050 },
      { text: 'life', startMs: 1050, endMs: 1400 },
    ];

    const first = await wordTimings(clip(), TEXT, 2600);
    const second = await wordTimings(clip(), TEXT, 2600);

    expect(second).toEqual(first);
    expect(aligner.calls).toBe(1);
    expect(timingCacheSize()).toBe(1);
  });

  it('keeps the estimate when the aligner fails', async () => {
    aligner.available = true;
    aligner.fail = true;

    const timings = await wordTimings(clip(), TEXT, 2000);

    expect(timings).toEqual(estimateTimings(TEXT, 2000));
    expect(timingCacheSize()).toBe(0);
  });

  it('gives up on a clip the aligner is slower than', async () => {
    vi.useFakeTimers();
    aligner.available = true;
    aligner.hang = true;

    const pending = wordTimings(clip(), TEXT, 100);
    await vi.advanceTimersByTimeAsync(4000);

    await expect(pending).resolves.toEqual(estimateTimings(TEXT, 100));
  });

  it('keeps at most one clip in the model and one waiting', async () => {
    vi.useFakeTimers();
    aligner.available = true;
    aligner.loaded = true;
    aligner.hang = true;

    const texts = Array.from({ length: 10 }, (_, index) => `sentence ${index}`);
    const requests = texts.map((text, index) => wordTimings(clip(1000 + index), text, 1000));
    await vi.advanceTimersByTimeAsync(0);

    // One clip is in the model and one is waiting; the older eight are answered
    // with their estimate instead of piling up in the worker. Before the queue
    // was bounded all ten reached the recogniser.
    expect(aligner.calls).toBe(1);
    expect(vi.getTimerCount()).toBe(2);

    await vi.advanceTimersByTimeAsync(4000);

    const settled = await Promise.all(requests);
    expect(settled).toEqual(texts.map((text) => estimateTimings(text, 1000)));
    // Both timed out: the recogniser is not keeping up, so it is dropped.
    expect(aligner.resets).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('answers a replaced waiting clip at once, without asking the model for it', async () => {
    vi.useFakeTimers();
    aligner.available = true;
    aligner.hang = true;

    const first = wordTimings(clip(1), 'first sentence', 1000);
    await vi.advanceTimersByTimeAsync(0);
    const second = wordTimings(clip(2), 'second sentence', 1000);
    await vi.advanceTimersByTimeAsync(0);
    const third = wordTimings(clip(3), 'third sentence', 1000);
    await vi.advanceTimersByTimeAsync(0);

    // The replaced clip is no longer being read: it gets its estimate now.
    await expect(second).resolves.toEqual(estimateTimings('second sentence', 1000));
    expect(aligner.calls).toBe(1);
    expect(vi.getTimerCount()).toBe(2);

    await vi.advanceTimersByTimeAsync(4000);
    await expect(first).resolves.toEqual(estimateTimings('first sentence', 1000));
    await expect(third).resolves.toEqual(estimateTimings('third sentence', 1000));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pauses the recogniser after repeated timeouts, then tries it again a minute later', async () => {
    vi.useFakeTimers();
    aligner.available = true;
    aligner.loaded = true;
    aligner.hang = true;

    const first = wordTimings(clip(1), 'first sentence', 1000);
    const second = wordTimings(clip(2), 'second sentence', 1000);
    await vi.advanceTimersByTimeAsync(4000);
    await expect(first).resolves.toEqual(estimateTimings('first sentence', 1000));
    await expect(second).resolves.toEqual(estimateTimings('second sentence', 1000));
    expect(aligner.resets).toBe(1);
    expect(aligner.calls).toBe(1);

    // During the pause the worker is left alone: the estimate is the answer.
    const third = wordTimings(clip(3), 'third sentence', 1000);
    await expect(third).resolves.toEqual(estimateTimings('third sentence', 1000));
    expect(aligner.calls).toBe(1);
    expect(aligner.resets).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    const fourth = wordTimings(clip(4), 'fourth sentence', 1000);
    await vi.advanceTimersByTimeAsync(4000);
    await expect(fourth).resolves.toEqual(estimateTimings('fourth sentence', 1000));
    expect(aligner.calls).toBe(2);
  });

  it('does not blame the recogniser for a cold model load', async () => {
    vi.useFakeTimers();
    aligner.available = true;
    aligner.hang = true;

    // The first session is still loading its weights: both clips time out, and
    // neither counts as the model being slow.
    const first = wordTimings(clip(1), 'first sentence', 1000);
    const second = wordTimings(clip(2), 'second sentence', 1000);
    await vi.advanceTimersByTimeAsync(4000);
    await expect(first).resolves.toEqual(estimateTimings('first sentence', 1000));
    await expect(second).resolves.toEqual(estimateTimings('second sentence', 1000));
    expect(aligner.calls).toBe(1);
    expect(aligner.resets).toBe(0);

    // Once it is loaded, the same behaviour is the model falling behind.
    aligner.loaded = true;
    const third = wordTimings(clip(3), 'third sentence', 1000);
    await vi.advanceTimersByTimeAsync(4000);
    await expect(third).resolves.toEqual(estimateTimings('third sentence', 1000));
    expect(aligner.resets).toBe(0);

    const fourth = wordTimings(clip(4), 'fourth sentence', 1000);
    await vi.advanceTimersByTimeAsync(4000);
    await expect(fourth).resolves.toEqual(estimateTimings('fourth sentence', 1000));
    expect(aligner.resets).toBe(1);
  });

  it('pauses the recogniser after repeated failures, then tries it again a minute later', async () => {
    vi.useFakeTimers();
    aligner.available = true;
    aligner.fail = true;

    const first = await wordTimings(clip(1), 'first sentence', 1000);
    const second = await wordTimings(clip(2), 'second sentence', 1000);
    expect(first).toEqual(estimateTimings('first sentence', 1000));
    expect(second).toEqual(estimateTimings('second sentence', 1000));
    // Two failures in a row: the worker is dropped (its pipeline is what broke)
    // and the third clip does not touch it at all.
    expect(aligner.resets).toBe(1);
    const third = await wordTimings(clip(3), 'third sentence', 1000);
    expect(third).toEqual(estimateTimings('third sentence', 1000));
    expect(aligner.calls).toBe(2);

    aligner.fail = false;
    aligner.words = [
      { text: 'fourth', startMs: 0, endMs: 400 },
      { text: 'sentence', startMs: 400, endMs: 900 },
    ];
    await vi.advanceTimersByTimeAsync(60_000);
    const fourth = await wordTimings(clip(4), 'fourth sentence', 1000);
    expect(aligner.calls).toBe(3);
    expect(fourth).not.toEqual(estimateTimings('fourth sentence', 1000));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not leave its budget timer behind when the model answers in time', async () => {
    vi.useFakeTimers();
    aligner.available = true;
    aligner.words = [
      { text: 'Digoxin', startMs: 0, endMs: 500 },
      { text: 'has', startMs: 500, endMs: 700 },
      { text: 'a', startMs: 700, endMs: 780 },
      { text: 'half', startMs: 780, endMs: 1050 },
      { text: 'life', startMs: 1050, endMs: 1400 },
    ];

    const timings = await wordTimings(clip(), TEXT, 2600);

    expect(timings).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('forgets the oldest clips before the cache can grow without bound', async () => {
    aligner.available = true;
    aligner.words = [{ text: 'Digoxin', startMs: 0, endMs: 100 }];

    for (let index = 0; index < 205; index++) await wordTimings(clip(1000 + index), TEXT, 2000);

    expect(timingCacheSize()).toBe(200);
  });
});

describe('alignTimeoutMs', () => {
  it('is four clip lengths, and never less than four seconds', () => {
    expect(alignTimeoutMs(100)).toBe(4000);
    expect(alignTimeoutMs(1000)).toBe(4000);
    expect(alignTimeoutMs(5000)).toBe(20000);
  });
});
