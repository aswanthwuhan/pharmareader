// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kokoroEngine, resetKokoroEngine } from './kokoro';
import { setModelReady } from './models';
import type { KokoroRequest, KokoroResponse } from './kokoroProtocol';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<KokoroResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly posted: KokoroRequest[] = [];
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: KokoroRequest): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(message: KokoroResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<KokoroResponse>);
  }

  fail(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

let startedSources = 0;

class FakeSource {
  buffer: AudioBuffer | null = null;
  playbackRate = { value: 1 };
  onended: (() => void) | null = null;
  connect(): void {}
  disconnect(): void {}
  start(): void {
    startedSources++;
    this.onended?.(); // an utterance ends immediately in the test
  }
  stop(): void {}
}

class FakeAudioContext {
  state = 'running';
  destination = {};
  createBuffer(_channels: number, length: number): AudioBuffer {
    return { getChannelData: () => new Float32Array(length) } as unknown as AudioBuffer;
  }
  createBufferSource(): AudioBufferSourceNode {
    return new FakeSource() as unknown as AudioBufferSourceNode;
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('timed out waiting for the engine');
}

function lastWorker(): FakeWorker {
  const worker = FakeWorker.instances.at(-1);
  if (!worker) throw new Error('no worker was created');
  return worker;
}

beforeEach(() => {
  FakeWorker.instances = [];
  startedSources = 0;
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('AudioContext', FakeAudioContext);
});

afterEach(() => {
  resetKokoroEngine();
  vi.unstubAllGlobals();
});

describe('KokoroEngine', () => {
  it('does not start playback when stopped while the model is still loading', async () => {
    const spoken = kokoroEngine.speak([{ id: 's1', text: 'hello' }], { rate: 1 }, {});
    await waitFor(() => FakeWorker.instances.length === 1);
    const worker = lastWorker();
    await waitFor(() => worker.posted.length > 0);
    expect(worker.posted[0]).toMatchObject({ type: 'init' });

    kokoroEngine.stop();
    worker.reply({ type: 'ready', voices: ['af_heart'] });
    await spoken;

    expect(startedSources).toBe(0);
  });

  it('rejects prepare instead of hanging when the engine is reset mid-load', async () => {
    // isReady() also honours a cached download, so make sure nothing is cached here.
    await setModelReady('kokoro', false);
    const preparing = kokoroEngine.prepare();
    await waitFor(() => FakeWorker.instances.length === 1);
    const worker = lastWorker();
    await waitFor(() => worker.posted.length > 0);

    resetKokoroEngine();

    await expect(preparing).rejects.toThrow('Kokoro engine was reset');
    expect(worker.terminated).toBe(true);
    await expect(kokoroEngine.isReady()).resolves.toBe(false);
  });

  it('still reports ready after a reload when the model is already downloaded', async () => {
    // A page reload destroys the worker but not the 90–178 MB in Cache Storage; the
    // reader must keep using the on-device voice instead of silently going to the
    // system voice (what the phone bug report showed).
    await setModelReady('kokoro', true);
    resetKokoroEngine();

    await expect(kokoroEngine.isReady()).resolves.toBe(true);
    await setModelReady('kokoro', false);
  });

  it('surfaces a worker failure to prepare and recovers with a new worker', async () => {
    const first = kokoroEngine.prepare();
    await waitFor(() => FakeWorker.instances.length === 1);
    await waitFor(() => lastWorker().posted.length > 0);
    lastWorker().fail('shader compile failed');

    await expect(first).rejects.toThrow('shader compile failed');

    const second = kokoroEngine.prepare();
    await waitFor(() => FakeWorker.instances.length === 2);
    lastWorker().reply({ type: 'ready', voices: ['af_heart'] });
    await second;

    await expect(kokoroEngine.isReady()).resolves.toBe(true);
    expect(FakeWorker.instances[0].terminated).toBe(true);
  });
});
