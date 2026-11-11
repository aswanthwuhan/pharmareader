// @vitest-environment jsdom
/**
 * The load path when the settings store refuses writes.
 *
 * `init()` retires the precision row an older build saved ('q8'/'fp16') before it starts
 * the worker, and records `tts.model.kokoro.ready` after the load. Neither row is what
 * makes the model work: the weights are in Cache Storage and the engine holds them in
 * memory, so a store that cannot take a write (private mode, full quota) must not cost a
 * reader the model that is already on disk. That was the bug — prepare() rejected with
 * the storage error before any worker existed.
 *
 * The settings module is mocked here rather than in `kokoro.test.ts`, because every test
 * in that file needs the real (fake-indexeddb) store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  /** What an older build left behind: a precision this build no longer reads. */
  precision: 'q8' as string,
  setSetting: vi.fn(async (_key: string, _value: unknown): Promise<void> => {
    throw new Error('QuotaExceededError: the settings store is not writable');
  }),
}));

vi.mock('../../core/settings', () => ({
  getSetting: async (_key: string, fallback: unknown) => store.precision ?? fallback,
  setSetting: store.setSetting,
  useSetting: (_key: string, fallback: unknown) => fallback,
}));

import { kokoroEngine, resetKokoroEngine } from './kokoro';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly posted: unknown[] = [];
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(message: unknown): void {
    this.onmessage?.({ data: message } as MessageEvent);
  }
}

/** The worker `prepare()` starts, once it has been asked to load something. */
async function startedWorker(): Promise<FakeWorker> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const found = FakeWorker.instances.at(-1);
    if (found && found.posted.length > 0) return found;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('prepare() never started a worker — the load stopped before the model');
}

beforeEach(() => {
  FakeWorker.instances = [];
  store.precision = 'q8';
  store.setSetting.mockClear();
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  resetKokoroEngine();
  vi.unstubAllGlobals();
});

describe('a settings store that refuses writes', () => {
  it('loads fp32 anyway instead of failing before the worker exists', async () => {
    const preparing = kokoroEngine.prepare();
    const worker = await startedWorker();

    // The retire was attempted (and refused) before the init message went out.
    expect(store.setSetting).toHaveBeenCalled();
    expect(worker.posted[0]).toMatchObject({ type: 'init', dtype: 'fp32' });

    worker.reply({ type: 'ready', voices: ['af_heart'] });
    await expect(preparing).resolves.toBeUndefined();
    await expect(kokoroEngine.isReady()).resolves.toBe(true);
  });
});
