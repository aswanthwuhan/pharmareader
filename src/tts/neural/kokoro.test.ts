// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectDevice, kokoroEngine, resetKokoroEngine, usableDevice } from './kokoro';
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

describe('detectDevice', () => {
  const DESKTOP = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0', gpu: {} };
  // Android System WebView: `navigator.gpu` exists, `requestAdapter()` still resolves to null.
  const ANDROID_WEBVIEW = {
    userAgent:
      'Mozilla/5.0 (Linux; Android 16; sdk_gphone64_x86_64 Build/BE4B.251210.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/156.0.0.0 Mobile Safari/537.36',
    gpu: {},
  };

  it('takes WebGPU on a desktop browser that exposes it', () => {
    expect(detectDevice(DESKTOP)).toBe('webgpu');
  });

  it('stays on WASM in Android System WebView, where the adapter cannot be created', () => {
    expect(detectDevice(ANDROID_WEBVIEW)).toBe('wasm');
  });

  it('stays on WASM when navigator has no gpu at all', () => {
    expect(detectDevice({ userAgent: DESKTOP.userAgent })).toBe('wasm');
  });

  it('stays on WASM without a navigator (tests, old WebViews)', () => {
    expect(detectDevice(undefined)).toBe('wasm');
  });
});

describe('usableDevice', () => {
  const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0';

  it('keeps WebGPU where an adapter is actually handed out', async () => {
    const nav = { userAgent: DESKTOP_UA, gpu: { requestAdapter: async () => ({ device: 1 }) } };
    await expect(usableDevice(nav)).resolves.toBe('webgpu');
  });

  it('falls back to WASM when requestAdapter resolves to null', async () => {
    // Advertised but unusable: the Android WebView case measured on the emulator.
    const nav = { userAgent: DESKTOP_UA, gpu: { requestAdapter: async () => null } };
    await expect(usableDevice(nav)).resolves.toBe('wasm');
  });

  it('falls back to WASM when requestAdapter throws', async () => {
    const nav = {
      userAgent: DESKTOP_UA,
      gpu: {
        requestAdapter: async () => {
          throw new Error('no adapter');
        },
      },
    };
    await expect(usableDevice(nav)).resolves.toBe('wasm');
  });

  it('does not ask for an adapter when gpu is missing', async () => {
    await expect(usableDevice({ userAgent: DESKTOP_UA })).resolves.toBe('wasm');
    await expect(usableDevice(undefined)).resolves.toBe('wasm');
  });
});