import { describe, expect, it } from 'vitest';
import { createProgressAggregator } from './progress';

describe('createProgressAggregator', () => {
  it('folds per-file byte progress into one monotonic fraction', () => {
    const seen: number[] = [];
    const report = createProgressAggregator((fraction) => seen.push(fraction));

    report({ label: 'a.onnx', loaded: 50, total: 100 }); // half of a
    report({ label: 'b.onnx', loaded: 50, total: 100 }); // still a half overall
    // A new file starts with a large total: the bar must not jump or go back.
    report({ label: 'c.onnx', loaded: 10, total: 1000 });

    expect(seen).toEqual([0.5]);
  });

  it('ignores reports without bytes or without a callback', () => {
    const seen: number[] = [];
    const report = createProgressAggregator((fraction) => seen.push(fraction));
    report({ label: 'status' });
    report({ loaded: 5, total: 10 }); // no label → cannot attribute bytes
    expect(seen).toEqual([]);
    expect(() => createProgressAggregator(undefined)({ label: 'a', loaded: 1, total: 2 })).not.toThrow();
  });

  it('never reports 1 before prepare() finishes', () => {
    const seen: number[] = [];
    const report = createProgressAggregator((fraction) => seen.push(fraction));
    report({ label: 'a', loaded: 10, total: 10 });
    expect(seen).toEqual([0.99]);
  });

  it('reports each finished file in sequence', () => {
    const seen: number[] = [];
    const report = createProgressAggregator((fraction) => seen.push(fraction));
    report({ label: 'a', loaded: 25, total: 100 });
    report({ label: 'a', loaded: 50, total: 100 });
    report({ label: 'a', loaded: 100, total: 100 });
    expect(seen).toEqual([0.25, 0.5, 0.99]);
  });

  it('uses the known download size so the small first file cannot read 99%', () => {
    // The real Pocket download starts with bundle.json (24 KB) of ~180 MB.
    const seen: number[] = [];
    const report = createProgressAggregator((fraction) => seen.push(fraction), 180e6);
    report({ label: 'bundle.json', loaded: 24381, total: 24381 });
    expect(seen[0]).toBeLessThan(0.001);
    // The big file then drives the bar, still without reaching 100%.
    report({ label: 'flow_lm_main_int8.onnx', loaded: 76341079, total: 76341079 });
    expect(seen[1]).toBeCloseTo(76365460 / 180e6, 4);
    expect(seen[1]).toBeLessThan(0.5);
  });

  it('falls back to the started files when the expected size is unknown', () => {
    const seen: number[] = [];
    const report = createProgressAggregator((fraction) => seen.push(fraction), 0);
    report({ label: 'a', loaded: 50, total: 100 });
    expect(seen).toEqual([0.5]);
  });
});
