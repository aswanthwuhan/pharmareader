import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DETECT_TIMEOUT_MS, LOAD_TIMEOUT_MS, createLayoutDetector } from './detector';

vi.mock('./model', () => ({
  LAYOUT_MODEL: { inputSize: 640, threshold: 0.5 },
  loadLayoutModelBytes: async () => new ArrayBuffer(8),
}));

/** A worker that loads, then never answers a page: what a killed WebView worker looks like. */
class SilentWorker {
  static last: SilentWorker | null = null;
  /** Set to make the worker go quiet before it has even loaded. */
  static deadOnLoad = false;
  terminated = false;
  private listeners: ((event: MessageEvent) => void)[] = [];

  constructor() {
    SilentWorker.last = this;
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (type === 'message') this.listeners.push(listener);
  }
  removeEventListener(_type: string, listener: (event: MessageEvent) => void) {
    this.listeners = this.listeners.filter((other) => other !== listener);
  }
  postMessage(message: { type: string }) {
    if (message.type !== 'load' || SilentWorker.deadOnLoad) return;
    queueMicrotask(() => {
      for (const listener of [...this.listeners]) listener({ data: { type: 'loaded', ms: 1 } } as MessageEvent);
    });
  }
  terminate() {
    this.terminated = true;
  }
}

describe('createLayoutDetector', () => {
  beforeEach(() => {
    vi.stubGlobal('Worker', SilentWorker);
  });
  afterEach(() => {
    SilentWorker.deadOnLoad = false;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('gives up on a page the worker never answers, and stops the worker', async () => {
    const detector = await createLayoutDetector();
    vi.useFakeTimers();

    const page = detector!.detect(new Uint8ClampedArray(4), 600, 800);
    const outcome = expect(page).rejects.toThrow('stopped answering');
    await vi.advanceTimersByTimeAsync(DETECT_TIMEOUT_MS);
    await outcome;

    expect(SilentWorker.last?.terminated).toBe(true);
    // The next page fails at once instead of waiting another minute and a half.
    await expect(detector!.detect(new Uint8ClampedArray(4), 600, 800)).rejects.toThrow('stopped answering');
  });

  it('gives up on a worker that never finishes loading, and leaves no timer behind when it does', async () => {
    vi.useFakeTimers();
    SilentWorker.deadOnLoad = true;
    const start = createLayoutDetector();
    const outcome = expect(start).rejects.toThrow('took too long to load');
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);
    await outcome;
    expect(SilentWorker.last?.terminated).toBe(true);

    SilentWorker.deadOnLoad = false;
    const detector = await createLayoutDetector();
    expect(vi.getTimerCount()).toBe(0);
    detector!.dispose();
    // A second dispose (the caller's `finally`) is harmless.
    detector!.dispose();
  });
});
