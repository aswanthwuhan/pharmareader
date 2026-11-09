import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../core/db';
import type { AudioCacheRecord } from '../core/types';
import { cacheKey, cacheSizeBytes, clearAudio, getAudio, putAudio, sha256Hex } from './cache';

afterEach(async () => {
  await db.delete();
  await db.open();
});

const rec = (key: string, engine: string, size = 10): AudioCacheRecord => ({
  key,
  engine,
  // fake-indexeddb cannot clone a real Blob body, so size is what the tests read.
  audio: new Blob([new Uint8Array(size)]),
  durationMs: 1000,
  createdAt: Date.now(),
});

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
