// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { db } from '../../core/db';
import { getSetting, setSetting } from '../../core/settings';
import { resetDownload, startDownload } from '../downloads';
import { KOKORO_DTYPE_SETTING, KOKORO_VOICE_SETTING, kokoroEngine } from './kokoro';
import NeuralModelsPanel from './NeuralModelsPanel';
import { NEURAL_STAGES, neuralError } from './neuralError';

/** Lets each test choose the platform before the component renders. */
const platform = vi.hoisted(() => ({ native: false }));
/** What the browser can run; `ios` drives the iPhone memory warning. */
const caps = vi.hoisted(() => ({ supported: true, ios: false }));
/** The panel must unload the loaded model before fetching another precision. */
const kokoroReset = vi.hoisted(() => vi.fn());

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => platform.native },
}));
vi.mock('../capabilities', () => ({
  supportsNeuralVoices: () => caps.supported,
  neuralUnsupportedHint: () => "Needs iOS 16.4 or newer — your phone's built-in voice still works.",
}));
vi.mock('../../core/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/platform')>()),
  isIos: () => caps.ios,
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

/** jsdom has no media stack: `Audio` records play/pause for the voice test. */
class FakeAudio {
  static instances: FakeAudio[] = [];
  src: string;
  paused = false;
  private listeners = new Map<string, () => void>();

  constructor(src?: string) {
    this.src = src ?? '';
    FakeAudio.instances.push(this);
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, listener);
  }

  removeEventListener(type: string): void {
    this.listeners.delete(type);
  }

  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }
}

type UrlStatics = {
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
};

const savedCreate = (URL as unknown as UrlStatics).createObjectURL;
const savedRevoke = (URL as unknown as UrlStatics).revokeObjectURL;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Settings are shared through fake-indexeddb; a "Ready" flag or a saved voice
  // written by one case must not decide the next one.
  await db.settings.clear();
  FakeAudio.instances = [];
  vi.stubGlobal('Audio', FakeAudio);
  (URL as unknown as UrlStatics).createObjectURL = vi.fn(() => 'blob:sample');
  (URL as unknown as UrlStatics).revokeObjectURL = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  pocket.failWith = null;
  pocket.prepare = null;
  pocket.prepares = 0;
  caps.supported = true;
  caps.ios = false;
  resetDownload('pocket');
  resetDownload('kokoro');
  kokoroReset.mockClear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  platform.native = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (savedCreate) (URL as unknown as UrlStatics).createObjectURL = savedCreate;
  else delete (URL as unknown as UrlStatics).createObjectURL;
  if (savedRevoke) (URL as unknown as UrlStatics).revokeObjectURL = savedRevoke;
  else delete (URL as unknown as UrlStatics).revokeObjectURL;
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

/** Poll inside act() until `check` passes: Dexie writes resolve asynchronously. */
async function waitFor(check: () => boolean, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
  expect(check()).toBe(true);
}

async function waitForSetting(key: string, expected: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if ((await getSetting<string>(key, '')) === expected) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
  expect(await getSetting<string>(key, '')).toBe(expected);
}

describe('NeuralModelsPanel', () => {
  it('shows Pocket and the web Kokoro card on the web', async () => {
    const text = await renderPanel();

    expect(text).toContain('Pocket TTS');
    expect(text).toContain('Kokoro-82M');
    // One web build only: the card names its one size instead of offering a precision.
    // The q8/fp16 selectors played garbled audio, so they are gone.
    expect(text).not.toContain('Precision');
    expect(container.querySelector('#tts-kokoro-dtype')).toBeNull();
    expect(text).toContain('~320 MB');
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

  it('offers the Pocket voices before the model is downloaded or loaded', async () => {
    // The names live in the model bundle, so a fresh install has no download and
    // no worker to ask. Without a static list the picker would not exist at all
    // until after the first Play, and Pocket could never be given a voice.
    await renderPanel();

    const select = container.querySelector<HTMLSelectElement>('#voice-pocket');
    expect(select).not.toBeNull();
    expect([...select!.options].map((option) => option.value)).toEqual([
      'alba',
      'azelma',
      'cosette',
      'eponine',
      'fantine',
      'javert',
      'jean',
      'marius',
    ]);
  });

  it('offers a way to reclaim the retired q8 weights of an older download', async () => {
    // q8 was the default before this change, so an existing reader has the int8
    // weights on disk. They are not the model the app loads, so the card must neither
    // say "Ready" on them (the first Play would silently fetch ~320 MB) nor hide them:
    // Delete is how the reader gets the ~90 MB back.
    const base = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main';
    const requests = ['config.json', 'tokenizer.json', 'onnx/model_quantized.onnx'].map((name) => ({
      url: `${base}/${name}`,
    }));
    vi.stubGlobal('caches', {
      has: async (name: string) => name === 'transformers-cache',
      open: async () => ({ keys: async () => requests }),
    });
    await setSetting(KOKORO_DTYPE_SETTING, 'q8');

    const text = await renderPanel();
    const buttons = () => [...container.querySelectorAll('button')];
    expect(buttons().filter((button) => button.textContent === 'Download')).toHaveLength(2);
    expect(text).not.toContain('Ready');
    // Only Kokoro has files on disk, so this is its Delete, on a card that is not Ready.
    expect(buttons().filter((button) => button.textContent === 'Delete')).toHaveLength(1);
    // The Delete sits next to "Not downloaded", so the card says what it would free.
    expect(text).toContain('still using space on this device');

    await setSetting(KOKORO_DTYPE_SETTING, 'fp32');
  });

  it('does not take an older download for the weights the app loads', async () => {
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

  it('offers every web Kokoro voice and writes the picker to its own setting', async () => {
    await renderPanel();
    await waitFor(() => container.querySelector('#voice-kokoro') !== null);

    const select = container.querySelector<HTMLSelectElement>('#voice-kokoro')!;
    // The engine lists all 28 voices before the model is downloaded.
    expect(select.options).toHaveLength(28);
    const labels = [...select.options].map((option) => option.textContent ?? '');
    expect(labels).toContain('Heart (en-US)');
    expect(labels).toContain('Bella (en-US)');
    // The engine knows which voices are British (b*) and which are American.
    expect(labels.some((label) => label.includes('en-GB'))).toBe(true);

    const chosen = select.options[6]!.value;
    await act(async () => {
      select.value = chosen;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitForSetting(KOKORO_VOICE_SETTING, chosen);
  });

  it('disables each voice test until its model is downloaded, and says why', async () => {
    const text = await renderPanel();

    const tests = [...container.querySelectorAll('button')].filter(
      (button) => button.textContent === 'Test voice'
    );
    expect(tests).toHaveLength(2); // Pocket and the web Kokoro card
    expect(tests.every((button) => button.disabled)).toBe(true);
    expect(text).toContain('Download the model first');
  });

  it("speaks a sample with the chosen Kokoro voice at the book's rate, and stops on a second tap", async () => {
    // A finished fp32 load is what stands in for the 320 MB of weights here.
    await setSetting('tts.model.kokoro.ready', true);
    await setSetting('tts.rate', 1.2);
    const synthesize = vi.spyOn(kokoroEngine, 'synthesize').mockResolvedValue(new Blob(['wav']));
    const stop = vi.spyOn(kokoroEngine, 'stop').mockImplementation(() => undefined);

    await renderPanel();
    await waitFor(() => container.querySelector('#voice-kokoro') !== null);

    const card = container.querySelector<HTMLElement>('section[aria-labelledby="tts-kokoro-title"]')!;
    const select = card.querySelector<HTMLSelectElement>('#voice-kokoro')!;
    const chosen = select.options[3]!.value;
    await act(async () => {
      select.value = chosen;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitForSetting(KOKORO_VOICE_SETTING, chosen);
    // The picker only owns the new voice once the saved setting has rendered back into it.
    await waitFor(() => select.value === chosen);

    const test = [...card.querySelectorAll('button')].find(
      (button) => button.textContent === 'Test voice'
    );
    expect(test?.disabled).toBe(false);
    await act(async () => {
      test!.click();
    });
    await waitFor(() => synthesize.mock.calls.length === 1);

    const [spoken, options] = synthesize.mock.calls[0]!;
    expect(String(spoken)).toContain('This is how your book will sound');
    expect(options).toEqual({ voiceId: chosen, rate: 1.2 });
    // A voice check must never fill the audio cache.
    expect(await db.audioCache.count()).toBe(0);

    await waitFor(() =>
      [...card.querySelectorAll('button')].some((button) => button.textContent === 'Stop test')
    );
    const stopButton = [...card.querySelectorAll('button')].find(
      (button) => button.textContent === 'Stop test'
    );
    await act(async () => {
      stopButton!.click();
    });
    expect(stop).toHaveBeenCalled();
    expect(FakeAudio.instances.at(-1)?.paused).toBe(true);
  });

  it('marks both downloads unavailable on a browser that cannot run them', async () => {
    caps.supported = false;
    const text = await renderPanel();

    // One plain line per model, and nothing to tap that would waste 320 MB.
    const lines = [...container.querySelectorAll('p')].filter(
      (p) => p.textContent === "Needs iOS 16.4 or newer — your phone's built-in voice still works."
    );
    expect(lines).toHaveLength(2);
    expect(text).toContain('Not available here');
    const downloads = [...container.querySelectorAll('button')].filter(
      (button) => button.textContent === 'Download'
    );
    expect(downloads).toHaveLength(2);
    expect(downloads.every((button) => button.disabled)).toBe(true);
  });

  it('warns about memory beside both downloads on an iPhone', async () => {
    caps.ios = true;
    await renderPanel();

    const warnings = [...container.querySelectorAll('p')].filter((p) =>
      (p.textContent ?? '').includes('may close Safari on older iPhones')
    );
    expect(warnings).toHaveLength(2);
    for (const warning of warnings) {
      expect(warning.textContent).toBe(
        'Large: may close Safari on older iPhones. The built-in voice uses no extra memory.'
      );
    }
  });

  it('leaves the memory warning off the desktop', async () => {
    const text = await renderPanel();
    expect(text).not.toContain('may close Safari');
  });
});
