// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import NeuralModelsPanel from './NeuralModelsPanel';
import { NEURAL_STAGES, neuralError } from './neuralError';

/** Lets each test choose the platform before the component renders. */
const platform = vi.hoisted(() => ({ native: false }));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => platform.native },
}));
// The native panel has its own plugin dependencies; only its presence matters here.
vi.mock('./KokoroNativePanel', () => ({ default: () => null }));

/** Pocket's download fails on demand, like a blocked phone connection. */
const pocket = vi.hoisted(() => ({ failWith: null as Error | null }));
vi.mock('./pocket', () => ({
  POCKET_RATE_MIN: 0.8,
  POCKET_RATE_MAX: 1.25,
  resetPocketEngine: () => undefined,
  pocketEngine: {
    id: 'pocket',
    label: 'Pocket TTS',
    capabilities: { streaming: true, prerender: true, wordBoundaries: false, needsDownload: true },
    isReady: () => false,
    prepare: () => (pocket.failWith ? Promise.reject(pocket.failWith) : Promise.resolve()),
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
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  platform.native = false;
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
});
