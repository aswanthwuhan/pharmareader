import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../core/db';
import { setSetting } from '../../core/settings';
import { cacheKey } from '../cache';
import { cacheVoiceId } from '../cacheIdentity';
import {
  base64ToWavBlob,
  DEFAULT_KOKORO_SID,
  KOKORO_MODEL_SETTING,
  KOKORO_VOICE_SETTING,
  kokoroNativeEngine,
  sidFromVoiceId,
} from './kokoroNativeEngine';
import { isKokoroNativeAvailable } from './kokoroPlugin';

describe('kokoroNativeEngine contract', () => {
  it('identifies itself as the on-device Kokoro engine', () => {
    expect(kokoroNativeEngine.id).toBe('kokoro');
    expect(kokoroNativeEngine.label).toBe('Kokoro (on-device)');
    expect(kokoroNativeEngine.capabilities).toEqual({
      streaming: true,
      prerender: true,
      wordBoundaries: false,
      needsDownload: true,
    });
  });

  it('is not ready in a browser (the plugin is Android-only)', async () => {
    expect(isKokoroNativeAvailable()).toBe(false);
    await expect(kokoroNativeEngine.isReady()).resolves.toBe(false);
  });

  it('lists the English voices even before the model is downloaded', async () => {
    const voices = await kokoroNativeEngine.listVoices();
    expect(voices).toHaveLength(28);
    expect(voices[0]).toEqual({ id: '0', name: 'af_alloy', lang: 'en-US' });
    expect(voices.some((voice) => voice.id === String(DEFAULT_KOKORO_SID) && voice.name === 'af_heart')).toBe(true);
    expect(voices.filter((voice) => voice.lang === 'en-GB')).toHaveLength(8);
  });
});

describe('sidFromVoiceId', () => {
  it('reads the string speaker ids the engine exposes', () => {
    expect(sidFromVoiceId('3')).toBe(3);
    expect(sidFromVoiceId(' 11 ')).toBe(11);
    expect(sidFromVoiceId('0')).toBe(0);
  });

  it('falls back to af_heart for missing or junk ids', () => {
    expect(sidFromVoiceId(undefined)).toBe(DEFAULT_KOKORO_SID);
    expect(sidFromVoiceId('')).toBe(DEFAULT_KOKORO_SID);
    expect(sidFromVoiceId('af_heart')).toBe(DEFAULT_KOKORO_SID);
  });

  it('clamps ids into the range the model can serve', () => {
    expect(sidFromVoiceId('-5')).toBe(0);
    expect(sidFromVoiceId('9999')).toBe(103);
  });
});

describe('cache identity', () => {
  beforeEach(async () => {
    await db.settings.clear();
  });

  it('keys a clip by the speaker it will use, the fp32 weights and the chunked text', async () => {
    expect(await kokoroNativeEngine.cacheVariant?.()).toBe('3@fp32@chunked');
    await setSetting(KOKORO_VOICE_SETTING, '11');
    expect(await kokoroNativeEngine.cacheVariant?.()).toBe('11@fp32@chunked');
    // The settings panel measures with an explicit speaker: that request decides.
    expect(await kokoroNativeEngine.cacheVariant?.('7')).toBe('7@fp32@chunked');
  });

  it('migrates the int8 setting v0.3.3 wrote and keeps the build in the key', async () => {
    await setSetting(KOKORO_MODEL_SETTING, 'int8');
    // int8 clips are different weights: the key must not replay them as fp32 audio.
    expect(await kokoroNativeEngine.cacheVariant?.()).toBe('3@fp32@chunked');
  });

  it('gives the same sentence a different key after a speaker change', async () => {
    // The phone voice used to be the only voice in the key, so a Kokoro speaker change
    // replayed the cached sentences in the old one.
    const key = async (): Promise<string> =>
      cacheKey('Amlodipine 5 mg.', 'kokoro', await cacheVoiceId(kokoroNativeEngine, undefined), 1);

    await setSetting(KOKORO_VOICE_SETTING, '3');
    const heart = await key();
    expect(await key()).toBe(heart); // same speaker and build: the clip is still valid

    await setSetting(KOKORO_VOICE_SETTING, '11');
    expect(await key()).not.toBe(heart);
  });

  it('falls back like synthesize for a speaker id it cannot read', async () => {
    await setSetting(KOKORO_VOICE_SETTING, '11');
    // "en-US-language" is a phone voice, not a Kokoro speaker: synthesize uses af_heart.
    expect(await kokoroNativeEngine.cacheVariant?.('en-US-language')).toBe('3@fp32@chunked');
  });
});

describe('base64ToWavBlob', () => {
  it('decodes the plugin payload into an audio/wav Blob', async () => {
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x01]);
    const base64 = btoa(String.fromCharCode(...bytes));
    const blob = base64ToWavBlob(base64);
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBe(bytes.length);
    const roundTrip = new Uint8Array(await blob.arrayBuffer());
    expect(Array.from(roundTrip)).toEqual(Array.from(bytes));
  });
});
