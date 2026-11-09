import { describe, expect, it } from 'vitest';
import { audioDurationMs, changeSpeed, concatFloat32, encodeWav, wavDurationMs } from './wav';

const ascii = (bytes: Uint8Array, offset: number) =>
  String.fromCharCode(...bytes.subarray(offset, offset + 4));

describe('encodeWav', () => {
  it('writes a mono 16-bit RIFF header with the right sizes', async () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const blob = encodeWav(samples, 24000);

    expect(blob.type).toBe('audio/wav');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer);

    expect(bytes.length).toBe(44 + samples.length * 2);
    expect(ascii(bytes, 0)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + samples.length * 2);
    expect(ascii(bytes, 8)).toBe('WAVE');
    expect(ascii(bytes, 12)).toBe('fmt ');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(24000);
    expect(view.getUint32(28, true)).toBe(48000); // byte rate
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(bytes, 36)).toBe('data');
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
  });

  it('converts floats to signed 16-bit and clamps out-of-range input', async () => {
    const blob = encodeWav(new Float32Array([0, 0.5, -0.5, 2, -2]), 24000);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const pcm = new Int16Array(bytes.buffer, 44);
    expect(Array.from(pcm)).toEqual([0, 16383, -16384, 32767, -32768]);
  });

  it('handles an empty buffer without throwing', async () => {
    const blob = encodeWav(new Float32Array(0), 24000);
    expect((await blob.arrayBuffer()).byteLength).toBe(44);
    expect(await wavDurationMs(blob)).toBe(0);
  });
});

describe('concatFloat32', () => {
  it('joins chunks in order', () => {
    const out = concatFloat32([new Float32Array([1, 2]), new Float32Array([]), new Float32Array([3])]);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });

  it('returns the single chunk itself when there is only one', () => {
    const only = new Float32Array([1]);
    expect(concatFloat32([only])).toBe(only);
  });
});

describe('changeSpeed', () => {
  const ramp = Float32Array.from({ length: 100 }, (_, i) => i / 100);

  it('leaves samples untouched at 1x', () => {
    expect(changeSpeed(ramp, 1)).toBe(ramp);
    expect(changeSpeed(ramp, 1.0002)).toBe(ramp);
    expect(changeSpeed(new Float32Array(0), 2)).toHaveLength(0);
  });

  it('halves the length at 2x and doubles it at 0.5x', () => {
    expect(changeSpeed(ramp, 2)).toHaveLength(50);
    expect(changeSpeed(ramp, 0.5)).toHaveLength(200);
  });

  it('resamples the waveform rather than truncating it', () => {
    const doubled = changeSpeed(ramp, 2);
    // Every other input sample survives; the end of the ramp is preserved.
    expect(doubled[1]).toBeCloseTo(0.02, 5);
    expect(doubled[49]).toBeCloseTo(0.98, 5);
    const halved = changeSpeed(ramp, 0.5);
    expect(halved[2]).toBeCloseTo(0.01, 5);
    expect(halved[198]).toBeCloseTo(0.99, 5);
  });

  it('keeps a constant signal constant', () => {
    const constant = changeSpeed(new Float32Array(10).fill(0.25), 1.5);
    for (const value of constant) expect(value).toBeCloseTo(0.25, 6);
  });
});

describe('wavDurationMs', () => {
  it('computes duration from byte rate and data size', async () => {
    // 1 second of 24 kHz audio is 24000 samples = 48000 data bytes.
    const blob = encodeWav(new Float32Array(24000), 24000);
    expect(await wavDurationMs(blob)).toBeCloseTo(1000, 3);
  });

  it('returns 0 for non-WAV data', async () => {
    expect(await wavDurationMs(new Blob([new Uint8Array(64)]))).toBe(0);
    expect(await wavDurationMs(new Blob([new Uint8Array(4)]))).toBe(0);
  });
});

describe('audioDurationMs', () => {
  it('reads WAV without needing an AudioContext', async () => {
    const blob = encodeWav(new Float32Array(12000), 24000);
    expect(await audioDurationMs(blob)).toBeCloseTo(500, 3);
  });
});
