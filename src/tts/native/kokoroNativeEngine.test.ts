import { describe, expect, it } from 'vitest';
import {
  base64ToWavBlob,
  DEFAULT_KOKORO_SID,
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
