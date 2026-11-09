import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alignTimeoutMs, clearTimingCache, estimateTimings, timingCacheSize, wordTimings } from './index';
import type { TranscriptWord } from './types';

/** The aligner's worker client, replaced by a scriptable recogniser. */
const aligner = vi.hoisted(() => ({
  available: false,
  fail: false,
  hang: false,
  calls: 0,
  words: [] as TranscriptWord[],
}));

vi.mock('./whisper', () => ({
  isWhisperAvailable: () => Promise.resolve(aligner.available),
  transcribe: () => {
    aligner.calls++;
    if (aligner.hang) return new Promise(() => undefined);
    if (aligner.fail) return Promise.reject(new Error('decoder blew up'));
    return Promise.resolve({ words: aligner.words, text: '', ms: 120 });
  },
}));

function clip(bytes = 4000): Blob {
  return new Blob([new Uint8Array(bytes)]);
}

const TEXT = 'Digoxin has a half-life';

beforeEach(() => {
  clearTimingCache();
  aligner.available = false;
  aligner.fail = false;
  aligner.hang = false;
  aligner.calls = 0;
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
