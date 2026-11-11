// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { setSetting } from '../../core/settings';
import { resetDownload, startDownload } from '../downloads';
import { KOKORO_DTYPE_SETTING } from './kokoro';
import NeuralModelsPanel from './NeuralModelsPanel';
import { NEURAL_STAGES, neuralError } from './neuralError';

/** Lets each test choose the platform before the component renders. */
const platform = vi.hoisted(() => ({ native: false }));
/** The panel must unload the loaded model before fetching another precision. */
const kokoroReset = vi.hoisted(() => vi.fn());

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => platform.native },
}));
vi.mock('./kokoro', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./kokoro')>();
  return { ...actual, resetKokoroEngine: kokoroReset };
});
// The native panel has its own plugin dependencies; only its presence matters here.
vi.mock('./KokoroNativePanel', () => ({ default: () => null }));

/** Pocket's download fails on demand, like a blocked phone connection. */
const pocket = vi.hoisted(() => ({
  failWith: null as Error | null,
  prepare: null as null | ((onProgress?: (fraction: number) => void) => Promise<void>),
  prepares: 0,
}));
vi.mock('./pocket', () => ({
  POCKET_RATE_MIN: 0.8,
  POCKET_RATE_MAX: 1.25,
  resetPocketEngine: () => undefined,
  pocketEngine: {
    id: 'pocket',
    label: 'Pocket TTS',
    capabilities: { streaming: true, prerender: true, wordBoundaries: false, needsDownload: true },
    isReady: () => false,
    prepare: (onProgress?: (fraction: number) => void) => {
      pocket.prepares += 1;
      if (pocket.prepare) return pocket.prepare(onProgress);
      return pocket.failWith ? Promise.reject(pocket.failWith) : Promise.resolve();
    },
    listVoices: () => Promise.resolve([]),
    synthesize: () => Promise.resolve(new Blob()),
  },
}));

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  pocket.failWith = null;
  pocket.prepare = null;
  pocket.prepares = 0;
  resetDownload('pocket');
  resetDownload('kokoro');
  kokoroReset.mockClear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  platform.native = false;
  vi.unstubAllGlobals();
});

async function renderPanel(): Promise<string> {
  await act(async () => {
    root!.render(createElement(NeuralModelsPanel));
    // Let the download-state effect (Dexie + Cache Storage) settle.
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container.textContent ?? '';
}

describe('NeuralModelsPanel', () => {
  it('shows Pocket and the web Kokoro card on the web', async () => {
    const text = await renderPanel();

    expect(text).toContain('Pocket TTS');
    expect(text).toContain('Kokoro-82M');
    expect(text).toContain('Precision'); // web-only dtype selector
    expect(text).toContain('0.80×–1.25×'); // Pocket speed cap is disclosed
    expect(text).not.toContain('Kokoro server');
    expect(text).not.toContain('Server URL');

    // Nothing is downloaded here, so measuring would silently fetch 90–150 MB.
    const measure = [...container.querySelectorAll('button')].filter(
      (button) => button.textContent === 'Measure speed'
    );
    expect(measure).toHaveLength(2);
    expect(measure.every((button) => button.disabled)).toBe(true);

    // One disclosure per model, plus the panel-level intro: each model's controls
    // and its explanation share a single row instead of stacking two.
    const summaries = [...container.querySelectorAll('details.disc-sub > summary')].map(
      (summary) => summary.textContent
    );
    expect(summaries).toEqual(['How this works', 'Details', 'Details']);
    // Teal belongs to the row's one primary action, not to three download buttons.
    expect(container.querySelectorAll('.btn-primary')).toHaveLength(0);
  });

  it('offers fp32 when only the q8 weights of an older download are cached', async () => {
    // q8 was the default before this change, so an existing reader has the int8
    // weights on disk. They are not the fp32 model, and the card that said "Ready"
    // made the first Play start a silent ~320 MB download.
    const base = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main';
    const requests = ['config.json', 'tokenizer.json', 'onnx/model_quantized.onnx'].map((name) => ({
      url: `${base}/${name}`,
    }));
    vi.stubGlobal('caches', {
      has: async (name: string) => name === 'transformers-cache',
      open: async () => ({ keys: async () => requests }),
    });
    await setSetting(KOKORO_DTYPE_SETTING, 'fp32');

    const text = await renderPanel();
    const downloadButtons = () =>
      [...container.querySelectorAll('button')].filter((button) => button.textContent === 'Download');
    expect(downloadButtons()).toHaveLength(2); // Pocket has nothing, Kokoro has q8
    expect(text).not.toContain('Ready');

    // Choosing q8 makes those same files the model that will run, on the download
    // the reader already paid for.
    await act(async () => {
      await setSetting(KOKORO_DTYPE_SETTING, 'q8');
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect(downloadButtons()).toHaveLength(1);
    expect(container.textContent).toContain('Ready');

    await setSetting(KOKORO_DTYPE_SETTING, 'fp32');
  });

  it('does not take an older download for the weights the selection asks for', async () => {
    // The download store is keyed by model, not by precision: a finished q8 download
    // used to keep the card on "Ready" after switching to fp32, and offered no way to
    // fetch the fp32 weights at all.
    const base = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main';
    vi.stubGlobal('caches', {
      has: async (name: string) => name === 'transformers-cache',
      open: async () => ({
        keys: async () =>
          ['config.json', 'tokenizer.json', 'onnx/model_quantized.onnx'].map((name) => ({
            url: `${base}/${name}`,
          })),
      }),
    });
    await setSetting(KOKORO_DTYPE_SETTING, 'fp32');
    await startDownload('kokoro', async (report) => report({ fraction: 1 }));

    const text = await renderPanel();
    const downloadButtons = () =>
      [...container.querySelectorAll('button')].filter((button) => button.textContent === 'Download');
    expect(downloadButtons()).toHaveLength(2); // Pocket, and Kokoro's missing fp32
    expect(text).not.toContain('Ready');

    // Asking for the missing weights unloads the model first: a loaded engine answers
    // prepare() from memory with the old precision, and the card would then report a
    // download that never ran.
    await act(async () => {
      downloadButtons()[1].click();
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect(kokoroReset).toHaveBeenCalled();

    await setSetting(KOKORO_DTYPE_SETTING, 'fp32');
  });

  it('replaces the web Kokoro card with the native panel on a device', async () => {
    platform.native = true;
    const text = await renderPanel();

    expect(text).toContain('Pocket TTS');
    expect(text).not.toContain('Kokoro-82M');
    expect(text).not.toContain('Precision');
    expect(text).not.toContain('Kokoro server');
  });

  it('shows the failing stage and a copy button when a download fails', async () => {
    // The real engine wraps download failures with their stage; mirror that here.
    pocket.failWith = neuralError('pocket', NEURAL_STAGES.files, new Error('Failed to fetch'));
    await renderPanel();

    const download = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Download'
    );
    expect(download).toBeDefined();
    await act(async () => {
      download!.click();
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    expect(container.textContent).toContain('Failed while downloading model files');
    expect(container.textContent).toContain('Failed to fetch');
    expect(container.querySelector('details pre')?.textContent).toContain('stage: downloading model files');
    expect(
      [...container.querySelectorAll('button')].some((button) => button.textContent === 'Copy error details')
    ).toBe(true);
  });

  it('keeps the progress when the panel is left and opened again mid-download', async () => {
    let progress: ((fraction: number) => void) | undefined;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    pocket.prepare = (onProgress) => {
      progress = onProgress;
      return gate;
    };

    await renderPanel();
    const download = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Download'
    );
    await act(async () => {
      download!.click();
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    await act(async () => {
      progress?.(0.35);
    });
    expect(container.textContent).toContain('Downloading 35%');

    // Leave Settings: the card unmounts while the engine is still downloading.
    await act(async () => root!.unmount());
    root = createRoot(container);

    const again = await renderPanel();
    expect(again).toContain('Downloading 35%');
    expect(again).not.toContain('Failed');
    // The remount joined the running download instead of starting another one.
    expect(pocket.prepares).toBe(1);

    await act(async () => {
      finish();
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect(container.textContent).toContain('Ready');
    expect(pocket.prepares).toBe(1);
  });
});
