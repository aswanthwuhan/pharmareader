// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDownload } from '../downloads';
import KokoroNativePanel, { KOKORO_DOWNLOAD_ID } from './KokoroNativePanel';

/**
 * The plugin and the engine are native; only their contract matters here: a
 * download that keeps running while the React panel is gone.
 */
const native = vi.hoisted(() => ({
  prepare: null as
    | null
    | ((onProgress: (fraction: number) => void, onStage: (stage: string) => void) => Promise<void>),
  prepares: 0,
  queries: 0,
  status: null as null | (() => Promise<Record<string, unknown>>),
  listener: null as null | ((progress: { fraction: number }) => void),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
}));

vi.mock('../native/kokoroPlugin', () => ({
  isKokoroNativeAvailable: () => true,
  Kokoro: {
    status: () =>
      native.status
        ? native.status()
        : Promise.resolve({ downloaded: false, loaded: false, sizeBytes: 0 }),
    addListener: async (_event: string, listener: (progress: { fraction: number }) => void) => {
      native.listener = listener;
      return { remove: () => Promise.resolve() };
    },
  },
}));

vi.mock('../native/kokoroNativeEngine', () => ({
  DEFAULT_KOKORO_SID: 3,
  KOKORO_THREADS_SETTING: 'tts.kokoro.threads',
  KOKORO_VOICE_SETTING: 'tts.voice.kokoro',
  kokoroNativeEngine: {
    prepare: (onProgress: (fraction: number) => void, onStage: (stage: string) => void) => {
      native.prepares += 1;
      return native.prepare ? native.prepare(onProgress, onStage) : Promise.resolve();
    },
    listVoices: () => Promise.resolve([]),
    measure: () => Promise.resolve({ rtf: 0.5, durationMs: 100, elapsedMs: 200, sampleRate: 24000 }),
    deleteModel: () => Promise.resolve(),
  },
}));

vi.mock('./benchmark', () => ({
  measureRtf: () => Promise.resolve(1),
  rtfSettingKey: (id: string) => `tts.rtf.${id}`,
}));

/** Poll the plugin quickly so the BUSY wait does not take seconds in a test. */
vi.mock('../native/kokoroDownload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../native/kokoroDownload')>();
  return {
    ...actual,
    followRunningDownload: (options: Parameters<typeof actual.followRunningDownload>[0]) =>
      actual.followRunningDownload({ ...options, pollMs: 5 }),
  };
});

let root: Root | null = null;
let container: HTMLDivElement;

function text(): string {
  return container.textContent ?? '';
}

async function settle(ms = 25): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function render(): Promise<string> {
  await act(async () => {
    root!.render(createElement(KokoroNativePanel));
    // Let the Dexie settings and the plugin status settle.
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  await settle(0);
  return text();
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((element) => element.textContent === label);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  native.prepare = null;
  native.prepares = 0;
  native.queries = 0;
  native.status = null;
  native.listener = null;
  resetDownload(KOKORO_DOWNLOAD_ID);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
});

describe('KokoroNativePanel', () => {
  it('keeps the download progress when Settings is left and opened again', async () => {
    let progress!: (fraction: number) => void;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    native.prepare = (onProgress) => {
      progress = onProgress;
      return gate.then(() => onProgress(1));
    };

    await render();
    expect(text()).toContain('Download model (334 MB)');
    const download = button('Download model (334 MB)');
    await act(async () => {
      download!.click();
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    await act(async () => {
      progress(0.35);
    });
    expect(text()).toContain('Downloading 35%');
    expect(container.querySelector('progress')?.value).toBeCloseTo(0.35, 2);

    // Leave Settings: the card unmounts while the native download keeps running.
    await act(async () => root!.unmount());
    root = createRoot(container);

    const again = await render();
    expect(again).toContain('Downloading 35%');
    expect(again).not.toContain('Error');
    expect(native.prepares).toBe(1);

    await act(async () => {
      finish();
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect(text()).toContain('Ready');
    // The remount joined the download instead of starting a second one.
    expect(native.prepares).toBe(1);
  });

  it('treats a BUSY plugin as "already downloading" and waits for it', async () => {
    native.status = () => {
      native.queries += 1;
      if (native.queries <= 1) {
        return Promise.resolve({
          downloaded: false,
          loaded: false,
          sizeBytes: 0,
          partialBytes: 0,
          archiveBytes: 349_886_476,
        });
      }
      if (native.queries <= 2) {
        return Promise.resolve({
          downloaded: false,
          loaded: false,
          sizeBytes: 0,
          partialBytes: 174_943_238,
          archiveBytes: 349_886_476,
        });
      }
      return Promise.resolve({ downloaded: true, loaded: true, sizeBytes: 333, threads: 4 });
    };
    native.prepare = (onProgress) => {
      if (native.prepares === 1) {
        // What the plugin answers when the io thread is already downloading.
        return Promise.reject(
          Object.assign(new Error('A model download is already running'), { code: 'BUSY' })
        );
      }
      onProgress(1);
      return Promise.resolve();
    };

    await render();
    const download = button('Download model (334 MB)');
    await act(async () => {
      download!.click();
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    expect(text()).not.toContain('failed');
    expect(text()).not.toContain('Error');
    expect(text()).toContain('Ready');
    // The BUSY attempt plus the load after the download finished.
    expect(native.prepares).toBe(2);
  });

  it('says it is loading the model, not unpacking it, once the archive is unpacked', async () => {
    let finishLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      finishLoad = resolve;
    });
    let queries = 0;
    native.status = () => {
      queries += 1;
      // The mount probe sees no model; the BUSY wait then finds the other
      // download already finished, so only the load is left to do.
      return Promise.resolve(
        queries === 1
          ? {
              downloaded: false,
              loaded: false,
              sizeBytes: 0,
              partialBytes: 0,
              archiveBytes: 349_886_476,
            }
          : { downloaded: true, loaded: true, sizeBytes: 333, threads: 4 }
      );
    };
    native.prepare = (_onProgress, onStage) => {
      if (native.prepares === 1) {
        return Promise.reject(
          Object.assign(new Error('A model download is already running'), { code: 'BUSY' })
        );
      }
      // What the engine reports while it loads the unpacked weights.
      onStage('load');
      return loadGate;
    };

    await render();
    await act(async () => {
      button('Download model (334 MB)')!.click();
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    expect(text()).toContain('Loading the model into memory…');
    expect(text()).not.toContain('Unpacking the model archive');

    await act(async () => {
      finishLoad();
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect(text()).toContain('Ready');
  });

  it('still reports a real download failure with its stage and details', async () => {
    // The engine reports its stage before the plugin call it is about to fail in.
    native.prepare = (_onProgress, onStage) => {
      onStage('status');
      onStage('download');
      return Promise.reject(new Error('disk full'));
    };

    await render();
    await act(async () => {
      button('Download model (334 MB)')!.click();
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    expect(text()).toContain('Downloading the 334 MB model failed: disk full');
    expect(container.querySelector('details pre')?.textContent).toContain(
      'stage: download (downloading the 334 MB model)'
    );
    expect(text()).toContain('Error details');
    expect(text()).toContain('Copy error details');
  });

  it('offers to resume a half download after a restart instead of an error', async () => {
    native.status = () =>
      Promise.resolve({
        downloaded: false,
        loaded: false,
        sizeBytes: 0,
        partialBytes: 174_943_238,
        archiveBytes: 349_886_476,
      });

    const shown = await render();

    expect(shown).toContain('Resume download (334 MB)');
    expect(shown).toContain('A partial download is saved (50% of 334 MB)');
    expect(shown).not.toContain('Error');
  });
});
