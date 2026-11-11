// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_KOKORO_VOICE,
  KOKORO_DTYPE,
  KOKORO_DTYPE_SETTING,
  detectDevice,
  kokoroEngine,
  resetKokoroEngine,
  setKokoroVoice,
  usableDevice,
} from './kokoro';
import { cacheKey } from '../cache';
import { cacheVoiceId } from '../cacheIdentity';
import { getSetting, setSetting } from '../../core/settings';
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
    // A page reload destroys the worker but not the ~320 MB in Cache Storage; the
    // reader must keep using the on-device voice instead of silently going to the
    // system voice (what the phone bug report showed).
    await setModelReady('kokoro', true);
    resetKokoroEngine();

    await expect(kokoroEngine.isReady()).resolves.toBe(true);
    await setModelReady('kokoro', false);
  });

  it('shows load progress to a caller that joins an in-flight load', async () => {
    // A second screen (or a remounted settings panel) must see the same bar, not
    // an empty one until it finishes.
    const first: number[] = [];
    const second: number[] = [];
    const a = kokoroEngine.prepare((fraction) => first.push(fraction));
    await waitFor(() => FakeWorker.instances.length === 1);
    const b = kokoroEngine.prepare((fraction) => second.push(fraction));
    const worker = lastWorker();
    await waitFor(() => worker.posted.length > 0);

    worker.reply({ type: 'progress', fraction: 0.42 });
    worker.reply({ type: 'ready', voices: ['af_heart'] });
    await Promise.all([a, b]);

    expect(first).toContain(0.42);
    expect(second).toContain(0.42);
    expect(first.at(-1)).toBe(1);
    expect(second.at(-1)).toBe(1);
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

describe('weight precision', () => {
  /** A Cache Storage that holds exactly these Kokoro files. */
  function stubCaches(files: string[]): void {
    const base = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main';
    const requests = files.map((name) => ({ url: `${base}/${name}` }));
    vi.stubGlobal('caches', {
      has: async (name: string) => name === 'transformers-cache',
      open: async () => ({ keys: async () => requests }),
    });
  }

  afterEach(async () => {
    // The setting lives in fake-indexeddb for the whole file.
    await setSetting(KOKORO_DTYPE_SETTING, KOKORO_DTYPE);
  });

  it('has exactly one dtype, and it is fp32', () => {
    // The int8 export (q8) is the build that played gibberish and fp16 only saved
    // download size, so there is no precision choice left to make.
    expect(KOKORO_DTYPE).toBe('fp32');
  });

  it('loads fp32 even when a stored setting still asks for q8', async () => {
    // A reader who picked q8 (or a pre-fix install that defaulted to it) must not keep
    // getting the garbled weights: the stored choice is ignored *and* overwritten once,
    // so it cannot come back on the next load.
    await setSetting(KOKORO_DTYPE_SETTING, 'q8');
    const preparing = kokoroEngine.prepare();
    await waitFor(() => FakeWorker.instances.length === 1);
    const worker = lastWorker();
    await waitFor(() => worker.posted.length > 0);

    expect(worker.posted[0]).toMatchObject({ type: 'init', dtype: 'fp32' });
    await expect(getSetting(KOKORO_DTYPE_SETTING, '')).resolves.toBe('fp32');
    worker.reply({ type: 'ready', voices: ['af_heart'] });
    await preparing;
  });

  it('treats a stored fp16 as fp32 as well', async () => {
    await setSetting(KOKORO_DTYPE_SETTING, 'fp16');
    const preparing = kokoroEngine.prepare();
    await waitFor(() => FakeWorker.instances.length === 1);
    const worker = lastWorker();
    await waitFor(() => worker.posted.length > 0);

    expect(worker.posted[0]).toMatchObject({ type: 'init', dtype: 'fp32' });
    worker.reply({ type: 'ready', voices: ['af_heart'] });
    await preparing;
  });

  it('keeps the fp32 cache key, so clips rendered before the change stay valid', async () => {
    // Nothing loaded yet, and the legacy q8 row is still in the store: the key must be
    // the same `af_heart@fp32` an existing fp32 clip was saved under.
    await setSetting(KOKORO_DTYPE_SETTING, 'q8');
    expect(await kokoroEngine.cacheVariant?.()).toBe('af_heart@fp32@chunked');
  });

  it('does not report ready while only a retired precision is downloaded', async () => {
    // An existing reader downloaded q8 when that was the default and the ready flag is
    // set. fp32 can only come from a new download, so the reader must not be told the
    // model is already here (it would play the garbled weights or fail offline).
    stubCaches(['config.json', 'tokenizer.json', 'onnx/model_quantized.onnx']);
    resetKokoroEngine();
    await setModelReady('kokoro', true);
    await expect(kokoroEngine.isReady()).resolves.toBe(false);

    stubCaches(['config.json', 'tokenizer.json', 'onnx/model_fp16.onnx']);
    await expect(kokoroEngine.isReady()).resolves.toBe(false);

    // The fp32 file is the model, whatever else is lying around.
    stubCaches(['config.json', 'tokenizer.json', 'onnx/model.onnx']);
    await expect(kokoroEngine.isReady()).resolves.toBe(true);
    await setModelReady('kokoro', false);
  });
});

describe('voice identity', () => {
  beforeEach(async () => {
    // `voiceIds` is whatever the worker's ready message listed, and it survives a reset
    // (the real worker always lists the same 28 voices). Load it once with the voices
    // these tests use, so a saved voice is a voice the engine actually has.
    resetKokoroEngine();
    const preparing = kokoroEngine.prepare();
    await waitFor(() => FakeWorker.instances.length === 1);
    const worker = lastWorker();
    await waitFor(() => worker.posted.length > 0);
    worker.reply({ type: 'ready', voices: ['af_heart', 'af_bella', 'am_adam'] });
    await preparing;
  });

  afterEach(async () => {
    // Both live in fake-indexeddb for the whole file.
    await setKokoroVoice(DEFAULT_KOKORO_VOICE);
    await setSetting(KOKORO_DTYPE_SETTING, KOKORO_DTYPE);
  });

  it('names the voice it will speak with, not the phone voice in the request', async () => {
    await setKokoroVoice('af_bella');
    expect(await kokoroEngine.cacheVariant?.()).toBe('af_bella@fp32@chunked');

    await setKokoroVoice('am_adam');
    expect(await kokoroEngine.cacheVariant?.()).toBe('am_adam@fp32@chunked');
  });

  it('gives the same sentence a different key after a voice change', async () => {
    // The bug: the reader hands every engine the phone voice, so the key held no trace
    // of the Kokoro voice and changing it replayed the cached sentences in the old one.
    const key = async (): Promise<string> =>
      cacheKey('Paracetamol 500 mg.', 'kokoro', await cacheVoiceId(kokoroEngine, undefined), 1);

    await setKokoroVoice('af_heart');
    const heart = await key();
    expect(await key()).toBe(heart); // same voice and precision: the clip is still valid

    await setKokoroVoice('am_adam');
    expect(await key()).not.toBe(heart);
  });

  it('falls back to the first voice for an id it does not have, as synthesize does', async () => {
    // "en-US-language" is a phone voice id, not a Kokoro one: synthesize silently uses
    // voiceIds[0], so the key must say that voice rather than claim the phone voice.
    await setKokoroVoice('af_heart');
    expect(await kokoroEngine.cacheVariant?.('en-US-language')).toBe('af_heart@fp32@chunked');
  });

  it('asks the worker for the voice the cache identity names', async () => {
    // Keying `af_bella@fp32` is only correct if the clip really is af_bella audio.
    await setKokoroVoice('af_bella');
    const rendering = kokoroEngine.synthesize!('Paracetamol.', { rate: 1 });
    const worker = lastWorker();
    await waitFor(() => worker.posted.some((message) => message.type === 'speak'));

    const speak = worker.posted.find((message) => message.type === 'speak');
    expect(speak).toMatchObject({ voice: 'af_bella' });
    worker.reply({
      type: 'result',
      id: speak?.type === 'speak' ? speak.id : 0,
      audio: new Float32Array([0.1, -0.1]),
      sampleRate: 24000,
    });
    await expect(rendering).resolves.toBeInstanceOf(Blob);
    expect(await kokoroEngine.cacheVariant?.()).toBe('af_bella@fp32@chunked');
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