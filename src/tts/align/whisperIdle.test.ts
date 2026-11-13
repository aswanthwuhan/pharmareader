import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WhisperRequest, WhisperResponse } from './whisperProtocol';
import { isWhisperLoaded, resetWhisperWorker, transcribe } from './whisper';

/**
 * A worker that answers a warm-up and a clip immediately, so the only thing the
 * test has to move is the clock. `hold` keeps a clip in flight instead.
 */
class IdleWorker {
  static instances: IdleWorker[] = [];
  static hold = false;

  onmessage: ((event: MessageEvent<WhisperResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;

  posted: WhisperRequest[] = [];
  terminated = false;

  constructor() {
    IdleWorker.instances.push(this);
  }

  postMessage(message: WhisperRequest): void {
    this.posted.push(message);
    if (IdleWorker.hold && message.type === 'align') return;
    queueMicrotask(() => {
      if (message.type === 'init') this.respond({ type: 'ready' });
      else if (message.type === 'align') {
        this.respond({ type: 'result', id: message.id, words: [], text: '', ms: 1 });
      }
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(message: WhisperResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<WhisperResponse>);
  }
}

vi.mock('./whisperModel', () => ({
  isWhisperDownloaded: () => Promise.resolve(true),
  setWhisperReady: () => Promise.resolve(),
  deleteWhisperFiles: () => Promise.resolve(),
}));

vi.mock('./decode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./decode')>();
  return { ...actual, decodeToMono16k: () => Promise.resolve(new Float32Array(1600)) };
});

function clip(): Blob {
  return new Blob([new Uint8Array(4000)]);
}

beforeEach(() => {
  vi.useFakeTimers();
  resetWhisperWorker();
  IdleWorker.instances = [];
  IdleWorker.hold = false;
  vi.stubGlobal('Worker', IdleWorker);
});

afterEach(() => {
  resetWhisperWorker();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the idle aligner', () => {
  it('releases the model after a minute without a clip, and reloads on the next one', async () => {
    await expect(transcribe(clip())).resolves.toBeDefined();
    const worker = IdleWorker.instances[0]!;
    expect(isWhisperLoaded()).toBe(true);

    // A minute of reading without word timing must leave the worker alone until
    // the full minute has passed.
    await vi.advanceTimersByTimeAsync(59_000);
    expect(worker.terminated).toBe(false);
    expect(isWhisperLoaded()).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(worker.terminated).toBe(true);
    expect(isWhisperLoaded()).toBe(false);

    // The next chapter builds a new worker instead of posting into the dead one.
    await expect(transcribe(clip())).resolves.toBeDefined();
    expect(IdleWorker.instances).toHaveLength(2);
    expect(IdleWorker.instances[1]!.posted[0]).toEqual({ type: 'init' });
    expect(isWhisperLoaded()).toBe(true);
  });

  it('never drops a worker that is still aligning a clip', async () => {
    IdleWorker.hold = true;
    const pending = transcribe(clip());
    for (let turn = 0; turn < 20 && IdleWorker.instances[0]?.posted.length !== 2; turn++) {
      await Promise.resolve();
    }
    const worker = IdleWorker.instances[0]!;
    const align = worker.posted[1]!;
    if (align.type !== 'align') throw new Error('expected the clip to be sent');

    await vi.advanceTimersByTimeAsync(120_000);
    expect(worker.terminated).toBe(false);
    expect(isWhisperLoaded()).toBe(true);

    worker.respond({ type: 'result', id: align.id, words: [], text: '', ms: 1 });
    await expect(pending).resolves.toBeDefined();

    // Once the clip is done, the clock starts again.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(worker.terminated).toBe(true);
  });
});
