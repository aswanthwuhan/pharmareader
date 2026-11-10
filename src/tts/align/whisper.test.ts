import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WhisperRequest, WhisperResponse } from './whisperProtocol';
import type { WhisperResult } from './whisper';
import {
  isWhisperAvailable,
  isWhisperLoaded,
  resetWhisperWorker,
  transcribe,
} from './whisper';

/**
 * A stand-in for the module worker: records what the page posts, delivers
 * responses back, and can die the way a real one does (onerror) or fail to take
 * a message at all (a detached buffer throws inside postMessage).
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  static failFirstPost = false;

  onmessage: ((event: MessageEvent<WhisperResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;

  posted: WhisperRequest[] = [];
  terminated = false;
  throwOnPost = false;

  constructor() {
    FakeWorker.instances.push(this);
    this.throwOnPost = FakeWorker.failFirstPost;
  }

  postMessage(message: WhisperRequest): void {
    if (this.throwOnPost) {
      this.throwOnPost = false;
      throw new Error('DataCloneError: the buffer is detached');
    }
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Deliver a response the worker would have posted. */
  respond(message: WhisperResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<WhisperResponse>);
  }

  /** The worker process died (OOM, a wasm trap, an uncaught error). */
  crash(message = 'out of memory'): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

vi.mock('./whisperModel', () => ({
  isWhisperDownloaded: () => Promise.resolve(true),
  setWhisperReady: () => Promise.resolve(),
  deleteWhisperFiles: () => Promise.resolve(),
}));

vi.mock('./decode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./decode')>();
  return {
    ...actual,
    decodeToMono16k: () => Promise.resolve(new Float32Array(1600)),
  };
});

function clip(): Blob {
  return new Blob([new Uint8Array(4000)]);
}

const WORD = { text: 'Digoxin', startMs: 0, endMs: 100 };

/** Wait for the page→worker conversation to reach the next step. */
async function until(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100 && !check(); turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(check()).toBe(true);
}

/** Start one clip and wait until its worker has been asked to load. */
async function started(): Promise<{ worker: FakeWorker; result: Promise<WhisperResult> }> {
  const result = transcribe(clip());
  await until(() => FakeWorker.instances[0]?.posted.length === 1);
  const worker = FakeWorker.instances[0]!;
  expect(worker.posted[0]).toEqual({ type: 'init' });
  return { worker, result };
}

/** Answer the align message at `index` with a result. */
function answer(worker: FakeWorker, index: number, words = [WORD]): void {
  const message = worker.posted[index]!;
  if (message.type !== 'align') throw new Error(`expected a clip at ${index}`);
  worker.respond({ type: 'result', id: message.id, words, text: 'Digoxin', ms: 42 });
}

beforeEach(() => {
  resetWhisperWorker();
  FakeWorker.instances = [];
  FakeWorker.failFirstPost = false;
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  resetWhisperWorker();
  vi.unstubAllGlobals();
});

describe('the aligner worker client', () => {
  it('loads once, then resolves a clip with the words it was asked about', async () => {
    const { worker, result } = await started();
    worker.respond({ type: 'ready' });

    await until(() => worker.posted.length === 2);
    const message = worker.posted[1]!;
    if (message.type !== 'align') throw new Error('expected the clip to be sent');
    expect(message.sampleRate).toBe(16000);
    expect(message.audio).toBeInstanceOf(Float32Array);

    answer(worker, 1);
    await expect(result).resolves.toEqual({ words: [WORD], text: 'Digoxin', ms: 42 });
    expect(isWhisperLoaded()).toBe(true);
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it('keeps using the loaded worker for the next clip', async () => {
    const { worker, result } = await started();
    worker.respond({ type: 'ready' });
    await until(() => worker.posted.length === 2);
    answer(worker, 1);
    await expect(result).resolves.toBeDefined();

    const second = transcribe(clip());
    await until(() => worker.posted.length === 3);
    answer(worker, 2, []);

    await expect(second).resolves.toEqual({ words: [], text: 'Digoxin', ms: 42 });
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it('rejects the clip in flight when the worker dies, and a new worker serves the next one', async () => {
    const { worker, result } = await started();
    worker.respond({ type: 'ready' });
    await until(() => worker.posted.length === 2);

    worker.crash('the model ran out of memory');

    await expect(result).rejects.toThrow('the model ran out of memory');
    expect(worker.terminated).toBe(true);
    expect(isWhisperLoaded()).toBe(false);

    // The next clip gets a brand new worker instead of one that will never answer.
    const next = transcribe(clip());
    await until(() => FakeWorker.instances.length === 2);
    const replacement = FakeWorker.instances[1]!;
    await until(() => replacement.posted.length === 1);
    replacement.respond({ type: 'ready' });
    await until(() => replacement.posted.length === 2);
    answer(replacement, 1);

    await expect(next).resolves.toBeDefined();
  });

  it('rejects both clips that were in flight when the worker died', async () => {
    const first = transcribe(clip());
    const second = transcribe(clip());
    await until(() => FakeWorker.instances[0]?.posted.length === 1);
    const worker = FakeWorker.instances[0]!;
    // Both clips share the one load, then both wait on the model.
    worker.respond({ type: 'ready' });
    await until(() => worker.posted.filter((message) => message.type === 'align').length === 2);

    worker.crash('wasm trap');

    await expect(first).rejects.toThrow('wasm trap');
    await expect(second).rejects.toThrow('wasm trap');
    expect(worker.terminated).toBe(true);
  });

  it('drops a request the worker cannot take, and the next clip starts a new worker', async () => {
    const { worker, result } = await started();
    worker.respond({ type: 'ready' });
    await until(() => worker.posted.length === 2);
    answer(worker, 1);
    await expect(result).resolves.toBeDefined();

    // A detached buffer throws inside postMessage; the request must not stay
    // pending and the broken worker must not be reused.
    worker.throwOnPost = true;
    const rejected = transcribe(clip());
    await expect(rejected).rejects.toThrow('detached');
    expect(worker.terminated).toBe(true);

    const next = transcribe(clip());
    await until(() => FakeWorker.instances.length === 2);
    const replacement = FakeWorker.instances[1]!;
    await until(() => replacement.posted.length === 1);
    replacement.respond({ type: 'ready' });
    await until(() => replacement.posted.length === 2);
    answer(replacement, 1);

    await expect(next).resolves.toBeDefined();
  });

  it('drops a worker that cannot take the warm-up message at all', async () => {
    FakeWorker.failFirstPost = true;

    await expect(transcribe(clip())).rejects.toThrow('detached');
    const dead = FakeWorker.instances[0]!;
    expect(dead.terminated).toBe(true);
    expect(isWhisperLoaded()).toBe(false);

    // The next clip builds a new worker instead of posting into the dead one.
    FakeWorker.failFirstPost = false;
    const next = transcribe(clip());
    await until(() => FakeWorker.instances.length === 2);
    const replacement = FakeWorker.instances[1]!;
    await until(() => replacement.posted.length === 1);
    replacement.respond({ type: 'ready' });
    await until(() => replacement.posted.length === 2);
    answer(replacement, 1);

    await expect(next).resolves.toBeDefined();
  });

  it('retries the load when the worker reports a load error', async () => {
    const { worker, result } = await started();
    worker.respond({ type: 'error', message: 'Failed to fetch' });

    await expect(result).rejects.toThrow('Failed to fetch');
    expect(worker.terminated).toBe(false);

    const next = transcribe(clip());
    await until(() => worker.posted.length === 2);
    expect(worker.posted[1]).toEqual({ type: 'init' });
    worker.respond({ type: 'ready' });
    await until(() => worker.posted.length === 3);
    answer(worker, 2, []);

    await expect(next).resolves.toEqual({ words: [], text: 'Digoxin', ms: 42 });
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it('terminates the worker and rejects what was in flight on reset', async () => {
    const { worker, result } = await started();
    worker.respond({ type: 'ready' });
    await until(() => worker.posted.length === 2);

    resetWhisperWorker();

    await expect(result).rejects.toThrow('The aligner was reset');
    expect(worker.terminated).toBe(true);
    expect(isWhisperLoaded()).toBe(false);
    expect(await isWhisperAvailable()).toBe(true);
  });
});
