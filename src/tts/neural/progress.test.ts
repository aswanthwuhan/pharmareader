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
});
