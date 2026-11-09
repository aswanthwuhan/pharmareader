import { describe, expect, it } from 'vitest';
import { estimateTimings } from './index';

describe('estimateTimings', () => {
  it('covers the whole clip in order, longer words get more time', () => {
    const t = estimateTimings('Digoxin has a half-life', 2000);
    expect(t.map((w) => w.charStart)).toEqual([0, 8, 12, 14]);
    expect(t[0].startMs).toBe(0);
    expect(t.at(-1)!.endMs).toBeCloseTo(2000);
    expect(t[0].endMs - t[0].startMs).toBeGreaterThan(t[2].endMs - t[2].startMs);
  });
});
