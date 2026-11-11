import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../core/db';
import { wavDurationMs } from '../cache';
import { encodeWav } from '../neural/wav';

/**
 * A phone with the plugin present. `synthesize` is the only call this path makes;
 * `stop` is needed because a cancel goes through `Kokoro.stop()`.
 */
const plugin = vi.hoisted(() => ({
  synthesize: vi.fn(),
  stop: vi.fn(async () => ({ stopped: true })),
}));
vi.mock('./kokoroPlugin', () => ({ isKokoroNativeAvailable: () => true, Kokoro: plugin }));

import { kokoroNativeEngine } from './kokoroNativeEngine';
import { decodeWav16 } from './wavJoin';

/**
 * 72 words of comma-separated clauses: long enough for `splitForModel` to cut it
 * into several pieces, each inside the model's 40-word budget.
 */
const LONG_SENTENCE = Array.from({ length: 24 }, (_, i) => `clause${i} about amlodipine`).join(', ') + '.';

function base64Of(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function wavBytes(samples: Float32Array, sampleRate = 24000): Promise<Uint8Array> {
  return new Uint8Array(await encodeWav(samples, sampleRate).arrayBuffer());
}

/** A clip the plugin would return: `samples` filled with `value` at 24 kHz. */
async function clipBase64(samples: number, value = 0.2): Promise<string> {
  return base64Of(await wavBytes(new Float32Array(samples).fill(value)));
}

function calls(): { text: string; sid: number; speed: number; threads: number; model: string }[] {
  return plugin.synthesize.mock.calls.map(([options]) => options);
}

describe('kokoroNativeEngine.synthesize on long sentences', () => {
  beforeEach(async () => {
    await db.settings.clear();
    plugin.synthesize.mockReset();
    plugin.stop.mockClear();
  });

  it('synthesises a long sentence clause by clause into one WAV', async () => {
    const lengths: number[] = [];
    plugin.synthesize.mockImplementation(async ({ text }: { text: string }) => {
      lengths.push(text.length);
      return { wavBase64: await clipBase64(text.length), sampleRate: 24000, durationMs: 1, rtf: 1 };
    });

    const blob = await kokoroNativeEngine.synthesize(LONG_SENTENCE, { rate: 1 });

    expect(calls().length).toBeGreaterThan(1);
    // The real contract: no single model call outruns the model's input window.
    for (const call of calls()) expect(call.text.split(/\s+/).length).toBeLessThanOrEqual(40);
    // No word may be lost at a seam: the clauses are the sentence with single spaces.
    expect(calls().map((call) => call.text).join(' ')).toBe(LONG_SENTENCE.replace(/\s+/g, ' ').trim());
    // Every clause uses the one resolution of voice, pace, threads and build.
    for (const call of calls()) {
      expect(call).toMatchObject({ sid: 3, speed: 1, threads: 2, model: 'fp32' });
    }
    const joined = decodeWav16(new Uint8Array(await blob.arrayBuffer()));
    expect(joined.sampleRate).toBe(24000);
    expect(joined.pcm.length).toBe(lengths.reduce((sum, length) => sum + length, 0));
    // The player times the clip from the blob itself, so the header must agree.
    expect(await wavDurationMs(blob)).toBeCloseTo((joined.pcm.length / 24000) * 1000, 0);
  });

  it('keeps every clause in the order it was spoken', async () => {
    let index = 0;
    plugin.synthesize.mockImplementation(async () => {
      index += 1;
      // A distinct level per clause: a join that reorders or drops a clip shows up here.
      return { wavBase64: await clipBase64(3, index / 10), sampleRate: 24000, durationMs: 1, rtf: 1 };
    });

    const blob = await kokoroNativeEngine.synthesize(LONG_SENTENCE, { rate: 1 });

    const joined = decodeWav16(new Uint8Array(await blob.arrayBuffer()));
    const blocks = Array.from({ length: joined.pcm.length / 3 }, (_, i) => Math.round(joined.pcm[i * 3]! * 10));
    expect(blocks).toEqual(calls().map((_, i) => i + 1));
  });

  it('returns the plugin WAV untouched when the sentence fits in one call', async () => {
    const samples = new Float32Array([0.5, -0.5, 0.25]);
    // The JUNK chunk puts the data past byte 44: a re-encode would come back shorter.
    const native = await wavBytes(samples);
    const withJunk = new Uint8Array(native.length + 12);
    withJunk.set(native.subarray(0, 12), 0);
    withJunk.set([0x4a, 0x55, 0x4e, 0x4b, 0x04, 0, 0, 0, 0, 0, 0, 0], 12); // "JUNK", size 4
    withJunk.set(native.subarray(12), 24);
    new DataView(withJunk.buffer).setUint32(4, withJunk.length - 8, true);
    plugin.synthesize.mockResolvedValue({
      wavBase64: base64Of(withJunk),
      sampleRate: 24000,
      durationMs: 1,
      rtf: 1,
    });

    const blob = await kokoroNativeEngine.synthesize('Amlodipine 5 mg once daily.', { rate: 1 });

    expect(calls()).toHaveLength(1);
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual(Array.from(withJunk));
  });

  it('stops after the clause it is on when stop() lands between clauses', async () => {
    let started = 0;
    plugin.synthesize.mockImplementation(async () => {
      started += 1;
      if (started === 1) queueMicrotask(() => kokoroNativeEngine.stop());
      return { wavBase64: await clipBase64(8, 0.1), sampleRate: 24000, durationMs: 1, rtf: 1 };
    });

    await expect(kokoroNativeEngine.synthesize(LONG_SENTENCE, { rate: 1 })).rejects.toThrow(/cancelled/i);

    expect(plugin.stop).toHaveBeenCalledTimes(1);
    expect(started).toBe(1);
  });

  it('stops when the plugin reports a cancelled clause', async () => {
    let started = 0;
    plugin.synthesize.mockImplementation(async () => {
      started += 1;
      if (started === 2) return { cancelled: true, sampleRate: 24000, durationMs: 0, rtf: 0 };
      return { wavBase64: await clipBase64(8, 0.1), sampleRate: 24000, durationMs: 1, rtf: 1 };
    });

    await expect(kokoroNativeEngine.synthesize(LONG_SENTENCE, { rate: 1 })).rejects.toThrow(/cancelled/i);

    // The third clause is never asked for.
    expect(started).toBe(2);
  });
});
