import { describe, expect, it } from 'vitest';
import { resampleLinear, toMono } from './decode';

describe('resampleLinear', () => {
  it('returns the samples untouched when the rate already matches', () => {
    const input = Float32Array.from([0.1, 0.2]);
    expect(resampleLinear(input, 16000, 16000)).toBe(input);
  });

  it('halves the length when going from 32 kHz to 16 kHz', () => {
    const input = Float32Array.from({ length: 32 }, (_, index) => index);
    const out = resampleLinear(input, 32000, 16000);
    expect(out).toHaveLength(16);
    expect(out[0]).toBeCloseTo(0);
    expect(out[8]).toBeCloseTo(16);
  });

  it('doubles the length when going from 8 kHz to 16 kHz', () => {
    const input = Float32Array.from([0, 10]);
    const out = resampleLinear(input, 8000, 16000);
    expect(out).toHaveLength(4);
    expect(out[0]).toBeCloseTo(0);
    expect(out[1]).toBeCloseTo(5);
    expect(out[3]).toBeCloseTo(10);
  });

  it('returns an empty array for an empty input', () => {
    expect(resampleLinear(new Float32Array(0), 48000, 16000)).toHaveLength(0);
  });
});

describe('toMono', () => {
  it('averages the channels', () => {
    const buffer = {
      numberOfChannels: 2,
      length: 2,
      getChannelData: (channel: number) => (channel === 0 ? Float32Array.from([1, 0]) : Float32Array.from([0, 1])),
    } as unknown as AudioBuffer;

    expect([...toMono(buffer)]).toEqual([0.5, 0.5]);
  });

  it('keeps a mono clip as it is', () => {
    const buffer = {
      numberOfChannels: 1,
      length: 2,
      getChannelData: () => Float32Array.from([0.25, -0.5]),
    } as unknown as AudioBuffer;

    expect([...toMono(buffer)]).toEqual([0.25, -0.5]);
  });
});
