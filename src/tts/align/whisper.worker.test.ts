import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WhisperRequest, WhisperResponse } from './whisperProtocol';

/** The transformers.js entry point, replaced by a scriptable pipeline. */
const hf = vi.hoisted(() => ({ pipeline: vi.fn() }));

vi.mock('@huggingface/transformers', () => ({
  env: { backends: { onnx: { wasm: {} } }, useBrowserCache: false, allowLocalModels: true },
  pipeline: hf.pipeline,
}));

vi.mock('../neural/neuralError', () => ({
  messageOf: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));
vi.mock('../neural/ort', () => ({ ORT_BASE_URL: '/ort/' }));
vi.mock('../neural/progress', () => ({ createProgressAggregator: () => () => undefined }));

interface FakeScope {
  location: { href: string };
  onmessage: ((event: MessageEvent<WhisperRequest>) => void) | null;
  postMessage(message: WhisperResponse): void;
}

let scope: FakeScope;
let posted: WhisperResponse[];

function send(message: WhisperRequest): void {
  scope.onmessage?.({ data: message } as MessageEvent<WhisperRequest>);
}

async function until(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100 && !check(); turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(check()).toBe(true);
}

function last(type: WhisperResponse['type']): WhisperResponse {
  const found = posted.filter((message) => message.type === type).at(-1);
  if (!found) throw new Error(`the worker posted no ${type}`);
  return found;
}

/** The worker is a side-effect module: load a fresh one per test. */
async function boot(): Promise<void> {
  vi.resetModules();
  await import('./whisper.worker');
}

type FakeModel = ReturnType<typeof vi.fn> & { dispose: ReturnType<typeof vi.fn> };

function recogniser(run: () => Promise<unknown>): { model: FakeModel; dispose: ReturnType<typeof vi.fn> } {
  const dispose = vi.fn(() => Promise.resolve());
  const model = Object.assign(vi.fn(run), { dispose });
  return { model, dispose };
}

beforeEach(() => {
  posted = [];
  scope = {
    location: { href: 'http://localhost/' },
    onmessage: null,
    postMessage: (message) => posted.push(message),
  };
  vi.stubGlobal('self', scope);
  hf.pipeline.mockReset();
});

describe('the aligner worker', () => {
  it('loads once and reports ready', async () => {
    const { model } = recogniser(() => Promise.resolve({ text: '' }));
    hf.pipeline.mockResolvedValue(model);
    await boot();

    send({ type: 'init' });
    await until(() => posted.some((message) => message.type === 'ready'));

    expect(hf.pipeline).toHaveBeenCalledTimes(1);
    expect(last('ready')).toEqual({ type: 'ready' });
  });

  it('throws away a session that failed, so the next clip loads a fresh one', async () => {
    const broken = recogniser(() => Promise.reject(new Error('OrtRun: out of memory')));
    const healthy = recogniser(() =>
      Promise.resolve({ text: ' Digoxin', chunks: [{ text: ' Digoxin', timestamp: [0, 0.4] }] })
    );
    hf.pipeline.mockResolvedValueOnce(broken.model).mockResolvedValueOnce(healthy.model);
    await boot();

    send({ type: 'init' });
    await until(() => posted.some((message) => message.type === 'ready'));

    const audio = new Float32Array(1600);
    send({ type: 'align', id: 7, audio, sampleRate: 16000 });
    await until(() => posted.some((message) => message.type === 'error'));

    expect(last('error')).toEqual({ type: 'error', id: 7, message: 'OrtRun: out of memory' });
    // The failed pipeline is disposed, and the next clip builds a new session.
    expect(broken.dispose).toHaveBeenCalledTimes(1);

    send({ type: 'align', id: 8, audio: new Float32Array(1600), sampleRate: 16000 });
    await until(() => posted.some((message) => message.type === 'result'));

    expect(hf.pipeline).toHaveBeenCalledTimes(2);
    expect(healthy.model).toHaveBeenCalledTimes(1);
    expect(last('result')).toMatchObject({
      type: 'result',
      id: 8,
      text: 'Digoxin',
      words: [{ text: 'Digoxin', startMs: 0, endMs: 400 }],
    });
  });

  it('keeps the loaded session for the next clip when nothing failed', async () => {
    const { model } = recogniser(() =>
      Promise.resolve({ text: 'a', chunks: [{ text: 'a', timestamp: [0, 0.1] }] })
    );
    hf.pipeline.mockResolvedValue(model);
    await boot();

    send({ type: 'init' });
    await until(() => posted.some((message) => message.type === 'ready'));

    send({ type: 'align', id: 1, audio: new Float32Array(1600), sampleRate: 16000 });
    await until(() => posted.filter((message) => message.type === 'result').length === 1);
    send({ type: 'align', id: 2, audio: new Float32Array(1600), sampleRate: 16000 });
    await until(() => posted.filter((message) => message.type === 'result').length === 2);

    expect(hf.pipeline).toHaveBeenCalledTimes(1);
  });

  it('does not unload a healthy session because a clip arrived at the wrong sample rate', async () => {
    const { model, dispose } = recogniser(() => Promise.resolve({ text: '' }));
    hf.pipeline.mockResolvedValue(model);
    await boot();

    send({ type: 'init' });
    await until(() => posted.some((message) => message.type === 'ready'));

    send({ type: 'align', id: 3, audio: new Float32Array(800), sampleRate: 8000 });
    await until(() => posted.some((message) => message.type === 'error'));

    expect(last('error')).toEqual({
      type: 'error',
      id: 3,
      message: 'The aligner needs 16000 Hz audio, got 8000 Hz',
    });
    expect(dispose).not.toHaveBeenCalled();
    expect(hf.pipeline).toHaveBeenCalledTimes(1);
  });
});
