import { describe, expect, it } from 'vitest';
import { MAX_WASM_THREADS, wasmThreadCount } from './threadBudget';

describe('wasmThreadCount', () => {
  it('stays at one thread when the context is not cross-origin isolated', () => {
    expect(wasmThreadCount({ crossOriginIsolated: false, hardwareConcurrency: 8 })).toBe(1);
  });

  it('stays at one thread when isolation is unknown', () => {
    expect(wasmThreadCount({ hardwareConcurrency: 8 })).toBe(1);
  });

  it('uses the core count when isolated', () => {
    expect(wasmThreadCount({ crossOriginIsolated: true, hardwareConcurrency: 3 })).toBe(3);
  });

  it('caps at the budget so the UI and audio threads keep a core', () => {
    expect(wasmThreadCount({ crossOriginIsolated: true, hardwareConcurrency: 16 })).toBe(MAX_WASM_THREADS);
  });

  it('never exceeds the cores actually present', () => {
    expect(wasmThreadCount({ crossOriginIsolated: true, hardwareConcurrency: 2 })).toBe(2);
  });

  it('falls back to one thread on a single-core or unknown device', () => {
    expect(wasmThreadCount({ crossOriginIsolated: true, hardwareConcurrency: 1 })).toBe(1);
    expect(wasmThreadCount({ crossOriginIsolated: true })).toBe(1);
    expect(wasmThreadCount({ crossOriginIsolated: true, hardwareConcurrency: Number.NaN })).toBe(1);
  });
});
