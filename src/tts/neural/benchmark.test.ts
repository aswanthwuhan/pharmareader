import { describe, expect, it, vi } from 'vitest';
import { getSetting } from '../../core/settings';
import type { TtsEngine } from '../../core/types';
import { measureRtf, rtfSettingKey, rtfVerdict, round } from './benchmark';
import { encodeWav } from './wav';

/** One second of 24 kHz audio, so RTF is just the elapsed seconds. */
function secondOfAudio(): Blob {
  return encodeWav(new Float32Array(24000), 24000);
}

function fakeEngine(synthesize = vi.fn(async () => secondOfAudio())): TtsEngine {
  return {
    id: 'kokoro',
    label: 'Fake Kokoro',
    capabilities: { streaming: true, prerender: true, wordBoundaries: false, needsDownload: true },
    isReady: async () => true,
    prepare: async () => {},
    listVoices: async () => [],
    speak: async () => {},
    stop: () => {},
    pause: () => {},
    resume: () => {},
    synthesize,
  };
}

describe('measureRtf', () => {
  it('warms up once, times the second run and persists the factor', async () => {
    const synthesize = vi.fn(async () => secondOfAudio());
    const result = await measureRtf(fakeEngine(synthesize), { voiceId: 'af_heart', rate: 1 });

    expect(synthesize).toHaveBeenCalledTimes(2); // warm-up + measurement
    expect(result.engineId).toBe('kokoro');
    expect(result.audioMs).toBeCloseTo(1000, 0);
    expect(result.rtf).toBeGreaterThanOrEqual(0);
    await expect(getSetting(rtfSettingKey('kokoro'), -1)).resolves.toBe(round(result.rtf));
  });

  it('divides the measured synthesis time by the audio duration', async () => {
    const now = vi.spyOn(performance, 'now');
    // Only the measured run is timed: start at 5 s, finish at 6.5 s.
    now.mockReturnValueOnce(5000).mockReturnValueOnce(6500);
    try {
      const result = await measureRtf(fakeEngine(), { rate: 1 });
      expect(result.synthMs).toBe(1500); // 1.5 s of compute…
      expect(result.audioMs).toBeCloseTo(1000, 0); // …for 1 s of audio
      expect(result.rtf).toBeCloseTo(1.5, 3);
      await expect(getSetting(rtfSettingKey('kokoro'), -1)).resolves.toBe(1.5);
    } finally {
      now.mockRestore();
    }
  });

  it('rejects engines without synthesize support', async () => {
    const engine = { ...fakeEngine(), synthesize: undefined } as unknown as TtsEngine;
    await expect(measureRtf(engine)).rejects.toThrow(/cannot synthesize/);
  });

  it('rejects undecodable audio instead of storing a bogus factor', async () => {
    const engine = fakeEngine(vi.fn(async () => new Blob([new Uint8Array(8)])));
    await expect(measureRtf(engine)).rejects.toThrow(/duration/);
  });
});

describe('rtfVerdict', () => {
  it('separates faster-than-real-time from slow engines', () => {
    expect(rtfVerdict(0.35)).toBe('Faster than real-time ✓');
    expect(rtfVerdict(0.99)).toBe('Faster than real-time ✓');
    expect(rtfVerdict(1)).toContain('Slower than real-time');
    expect(rtfVerdict(2.5)).toContain('use pre-render or system voice');
    expect(rtfVerdict(0)).toBe('Speed not measured');
    expect(rtfVerdict(Number.NaN)).toBe('Speed not measured');
  });
});
