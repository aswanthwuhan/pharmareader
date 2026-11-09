import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../core/db';
import type { AudioCacheRecord } from '../core/types';
import {
  DEFAULT_MAX_CACHE_BYTES,
  cacheKey,
  cacheSizeBytes,
  clearAudio,
  getAudio,
  pruneAudio,
  putAudio,
  sha256Hex,
  wavDurationMs,
} from './cache';

afterEach(async () => {
  await db.delete();
  await db.open();
});

const rec = (key: string, engine: string, size = 10, createdAt = Date.now()): AudioCacheRecord => ({
  key,
  engine,
  // fake-indexeddb drops a real Blob body (it reads back with size 0), so the
  // unit tests carry the byte size on a Blob-shaped value: cacheSizeBytes and
  // pruneAudio only ever read `.size`, and player/cache pass real Blobs.
  audio: { size } as Blob,
  durationMs: 1000,
  createdAt,
});

/** A minimal RIFF/WAVE header: 8 kHz, 8-bit mono, `dataSize` bytes of samples. */
function wavBlob(byteRate: number, dataSize: number): Blob {
  const buf = new Uint8Array(44 + dataSize);
  const view = new DataView(buf.buffer);
  const tag = (offset: number, text: string) => {
    for (let i = 0; i < 4; i++) buf[offset + i] = text.charCodeAt(i);
  };
  tag(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  tag(36, 'data');
  view.setUint32(40, dataSize, true);
  return new Blob([buf]);
}

describe('sha256Hex', () => {
  it('matches the known digests', async () => {
    // The pure-JS fallback is what jsdom uses, so these must both hold.
    expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('handles input longer than one 64-byte block', async () => {
    const long = 'a'.repeat(1000);
    expect(await sha256Hex(long)).toHaveLength(64);
    expect(await sha256Hex(long)).toBe(await sha256Hex(long));
  });
});

describe('cacheKey', () => {
  it('is stable and hex', async () => {
    const a = await cacheKey('Paracetamol 500 mg', 'system', 'v1', 1, 'abc123');
    const b = await cacheKey('Paracetamol 500 mg', 'system', 'v1', 1, 'abc123');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes with every input that changes the audio', async () => {
    const base = await cacheKey('text', 'system', 'v1', 1, 'lex');
    expect(await cacheKey('text2', 'system', 'v1', 1, 'lex')).not.toBe(base);
    expect(await cacheKey('text', 'pocket', 'v1', 1, 'lex')).not.toBe(base);
    expect(await cacheKey('text', 'system', 'v2', 1, 'lex')).not.toBe(base);
    expect(await cacheKey('text', 'system', 'v1', 1.5, 'lex')).not.toBe(base);
    expect(await cacheKey('text', 'system', 'v1', 1, 'lex2')).not.toBe(base);
  });

  it('treats an absent voice like the empty id without colliding fields', async () => {
    expect(await cacheKey('t', 'e', undefined, 1, 'l')).toBe(await cacheKey('t', 'e', '', 1, 'l'));
    // Field boundaries are unambiguous: voice+rate must not run into each other.
    expect(await cacheKey('t', 'e', '1', 2, 'l')).not.toBe(await cacheKey('t', 'e', '12', 2, 'l'));
  });
});

describe('audio cache', () => {
  it('stores and reads a record by key', async () => {
    const r = rec('k1', 'system');
    await putAudio(r);
    const found = await getAudio('k1');
    expect(found?.engine).toBe('system');
    expect(found?.durationMs).toBe(1000);
    expect(found?.audio).toBeTruthy();
    expect(await getAudio('nope')).toBeUndefined();
  });

  it('overwrites an existing key rather than duplicating', async () => {
    await putAudio(rec('k1', 'system'));
    await putAudio({ ...rec('k1', 'system'), durationMs: 2000 });
    expect(await db.audioCache.count()).toBe(1);
    expect((await getAudio('k1'))?.durationMs).toBe(2000);
  });

  it('reports total size and clears one engine only', async () => {
    await putAudio(rec('a', 'system', 10));
    await putAudio(rec('b', 'system', 20));
    await putAudio(rec('c', 'kokoro', 30));

    // fake-indexeddb drops Blob bodies, so the total is summed from what the DB
    // actually returns; in a real browser that is the three sizes above.
    let expected = 0;
    for (const key of ['a', 'b', 'c']) expected += (await getAudio(key))?.audio.size ?? 0;
    expect(await cacheSizeBytes()).toBe(expected);

    await clearAudio('system');
    expect(await db.audioCache.count()).toBe(1);
    expect(await getAudio('a')).toBeUndefined();
    expect(await getAudio('b')).toBeUndefined();
    expect(await getAudio('c')).toBeTruthy();

    await clearAudio();
    expect(await cacheSizeBytes()).toBe(0);
    expect(await db.audioCache.count()).toBe(0);
  });
});

describe('pruneAudio', () => {
  it('keeps a 300 MB default budget', () => {
    expect(DEFAULT_MAX_CACHE_BYTES).toBe(300 * 1024 * 1024);
  });

  it('leaves an under-budget cache untouched', async () => {
    await putAudio(rec('a', 'system'));
    expect(await pruneAudio(DEFAULT_MAX_CACHE_BYTES)).toBe(0);
    expect(await db.audioCache.count()).toBe(1);
  });

  it('evicts oldest-created rows first until the cache fits', async () => {
    await putAudio(rec('old', 'system', 10, 1));
    await putAudio(rec('mid', 'system', 10, 2));
    await putAudio(rec('new', 'system', 10, 3));

    // Budget: enough for the two newest only (10 bytes each as stored).
    const freed = await pruneAudio(20);
    expect(freed).toBeGreaterThan(0);
    expect(await getAudio('old')).toBeUndefined();
    expect((await db.audioCache.orderBy('createdAt').toArray()).map((r) => r.key)).toEqual(['mid', 'new']);
    expect(await cacheSizeBytes()).toBeLessThanOrEqual(20);
  });

  it('empties the cache when the budget is zero', async () => {
    await putAudio(rec('a', 'system', 5, 1));
    await putAudio(rec('b', 'system', 5, 2));
    await pruneAudio(0);
    expect(await db.audioCache.count()).toBe(0);
  });

  it('is called by putAudio so a full cache self-trims', async () => {
    // 20 bytes per record, budget 25: the second put must evict the first.
    await putAudio(rec('a', 'system', 20, 1), 25);
    await putAudio(rec('b', 'system', 20, 2), 25);
    expect(await db.audioCache.count()).toBe(1);
    expect(await getAudio('a')).toBeUndefined();
    expect(await getAudio('b')).toBeTruthy();
  });
});

describe('wavDurationMs', () => {
  it('reads PCM duration from the RIFF header', async () => {
    // byteRate 8000 B/s, 16000 data bytes -> 2 s.
    expect(await wavDurationMs(wavBlob(8000, 16000))).toBe(2000);
    expect(await wavDurationMs(wavBlob(16000, 8000))).toBe(500);
  });

  it('returns 0 for mp3, tiny and broken blobs', async () => {
    expect(await wavDurationMs(new Blob([new Uint8Array([0xff, 0xfb, 0x90, 0x64])]))).toBe(0);
    expect(await wavDurationMs(new Blob([new Uint8Array(10)]))).toBe(0);
    // RIFF but not WAVE.
    const notWave = new Uint8Array(44);
    notWave.set([0x52, 0x49, 0x46, 0x46], 0);
    notWave.set([0x41, 0x56, 0x49, 0x00], 8);
    expect(await wavDurationMs(new Blob([notWave]))).toBe(0);
  });

  it('survives a header with zero byteRate', async () => {
    const blob = wavBlob(0, 100);
    expect(await wavDurationMs(blob)).toBe(0);
  });
});
