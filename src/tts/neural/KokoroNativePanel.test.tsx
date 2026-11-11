// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../core/db';
import { getSetting, setSetting } from '../../core/settings';
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
  deleted: [] as string[],
  voices: [] as { id: string; name: string; lang: string }[],
  synthesize: null as null | ((text: string, opts: { voiceId?: string; rate: number }) => Promise<Blob>),
  stops: 0,
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
}));

vi.mock('../native/kokoroPlugin', () => ({
  isKokoroNativeAvailable: () => true,
  Kokoro: {
    status: (options?: { model?: string }) =>
      native.status
        ? native.status()
        : Promise.resolve({ downloaded: false, loaded: false, sizeBytes: 0, model: options?.model }),
    addListener: async (_event: string, listener: (progress: { fraction: number }) => void) => {
      native.listener = listener;
      return { remove: () => Promise.resolve() };
    },
    load: () => Promise.resolve({ loaded: true, threads: 2, sampleRate: 24000, voiceCount: 53 }),
  },
}));

vi.mock('../native/kokoroNativeEngine', () => ({
  DEFAULT_KOKORO_SID: 3,
  DEFAULT_KOKORO_THREADS: 2,
  DEFAULT_KOKORO_MODEL: 'fp32',
  KOKORO_THREADS_SETTING: 'tts.kokoro.threads',
  KOKORO_VOICE_SETTING: 'tts.voice.kokoro',
  // The real logic is small; keeping it here is what makes the "an int8-only phone is not
  // ready" case test the panel's actual behaviour.
  fp32Installed: (status: {
    downloaded?: boolean;
    models?: { key: string; downloaded?: boolean }[];
  }) => status.models?.find((model) => model.key === 'fp32')?.downloaded ?? status.downloaded,
  kokoroNativeEngine: {
    prepare: (onProgress: (fraction: number) => void, onStage: (stage: string) => void) => {
      native.prepares += 1;
      return native.prepare ? native.prepare(onProgress, onStage) : Promise.resolve();
    },
    listVoices: () => Promise.resolve(native.voices),
    synthesize: (text: string, opts: { voiceId?: string; rate: number }) =>
      native.synthesize ? native.synthesize(text, opts) : Promise.resolve(new Blob(['wav'])),
    speak: () => Promise.resolve(),
    stop: () => {
      native.stops += 1;
    },
    measure: () => Promise.resolve({ rtf: 0.5, durationMs: 100, elapsedMs: 200, sampleRate: 24000 }),
    deleteModel: (model?: string) => {
      native.deleted.push(model ?? '');
      return Promise.resolve();
    },
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

/**
 * jsdom has no media stack: this stub records play/pause so the voice test's
 * "second tap stops it" is a fact about the panel, not about jsdom's silence.
 */
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

  end(): void {
    this.listeners.get('ended')?.();
  }
}

type UrlStatics = {
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
};

const savedCreate = (URL as unknown as UrlStatics).createObjectURL;
const savedRevoke = (URL as unknown as UrlStatics).revokeObjectURL;
const revokeObjectURL = vi.fn();

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

/** Poll inside act() until `check` passes: Dexie writes and synthesis are asynchronous. */
async function waitFor(check: () => boolean, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) {
    await settle(25);
  }
  expect(check()).toBe(true);
}

async function waitForSetting(key: string, expected: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if ((await getSetting<string>(key, '')) === expected) return;
    await settle(25);
  }
  expect(await getSetting<string>(key, '')).toBe(expected);
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

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Settings are shared across cases through fake-indexeddb: clear them so a thread
  // scheme or a saved build written by one test cannot decide another one.
  await db.settings.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  native.prepare = null;
  native.prepares = 0;
  native.queries = 0;
  native.status = null;
  native.listener = null;
  native.deleted = [];
  native.voices = [];
  native.synthesize = null;
  native.stops = 0;
  FakeAudio.instances = [];
  revokeObjectURL.mockClear();
  vi.stubGlobal('Audio', FakeAudio);
  (URL as unknown as UrlStatics).createObjectURL = vi.fn(() => 'blob:sample');
  (URL as unknown as UrlStatics).revokeObjectURL = revokeObjectURL;
  resetDownload(KOKORO_DOWNLOAD_ID);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
  if (savedCreate) (URL as unknown as UrlStatics).createObjectURL = savedCreate;
  else delete (URL as unknown as UrlStatics).createObjectURL;
  if (savedRevoke) (URL as unknown as UrlStatics).revokeObjectURL = savedRevoke;
  else delete (URL as unknown as UrlStatics).revokeObjectURL;
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

    expect(text()).toContain('Downloading the model failed: disk full');
    expect(container.querySelector('details pre')?.textContent).toContain(
      'stage: download (downloading the model)'
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

    // One disclosure for the whole panel: the controls and the explanation
    // share a row, and the download is not the row's primary action.
    const summaries = [...container.querySelectorAll('details.disc-sub > summary')].map(
      (summary) => summary.textContent
    );
    expect(summaries).toEqual(['Details']);
    expect(button('Resume download (334 MB)')?.classList.contains('btn-secondary')).toBe(true);
    expect(container.querySelectorAll('.btn-primary')).toHaveLength(0);
  });

  it('offers one, two and four threads, labels 2 recommended and warns above two', async () => {
    await render();
    const select = container.querySelector<HTMLSelectElement>('#kokoro-native-threads');
    expect(select?.value).toBe('2');
    expect([...(select?.options ?? [])].map((option) => option.textContent)).toEqual([
      '1 thread (coolest, may pause between sentences)',
      '2 threads (recommended)',
      '4 threads (faster, gets hot)',
    ]);
    expect(text()).not.toContain('More threads finish sooner');

    await act(async () => {
      select!.value = '4';
      select!.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect(text()).toContain(
      'More threads finish sooner but keep more cores busy, and the phone gets warmer.'
    );
    expect(await getSetting('tts.kokoro.threads', 0)).toBe(4);
  });

  it('keeps the two threads v0.3.3 saved instead of migrating them', async () => {
    await setSetting('tts.kokoro.threads', 2);
    await render();

    const select = container.querySelector<HTMLSelectElement>('#kokoro-native-threads');
    expect(select?.value).toBe('2');
    expect(select?.selectedOptions[0]?.textContent).toBe('2 threads (recommended)');
    expect(text()).not.toContain('More threads finish sooner');
    // Read as it is: the panel writes nothing back.
    expect(await getSetting('tts.kokoro.threads', 0)).toBe(2);
  });

  it('shows a thread count saved by an older build as a "(saved)" option', async () => {
    await setSetting('tts.kokoro.threads', 6);
    await render();

    const select = container.querySelector<HTMLSelectElement>('#kokoro-native-threads');
    expect(select?.value).toBe('6');
    expect(select?.selectedOptions[0]?.textContent).toBe('6 threads (saved)');
    expect(text()).toContain('More threads finish sooner');
  });

  it('offers no lighter build, and deletes the INT8 files v0.3.3 left behind', async () => {
    native.status = () =>
      Promise.resolve({
        downloaded: true,
        loaded: true,
        sizeBytes: 340_000_000,
        model: 'fp32',
        archiveBytes: 349_886_476,
        models: [
          { key: 'int8', downloaded: true, archiveBytes: 132_353_410, sizeBytes: 132_353_410 },
          { key: 'fp32', downloaded: true, archiveBytes: 349_886_476, sizeBytes: 340_000_000 },
        ],
      });

    await render();

    expect(button('Download the lighter INT8 model (126 MB)')).toBeUndefined();
    expect(container.querySelector('#kokoro-native-model')).toBeNull();
    expect(text()).not.toContain('Lighter (int8)');

    const remove = button('Remove the old INT8 download (126 MB)');
    expect(remove).toBeDefined();
    await act(async () => {
      remove!.click();
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    // Only the int8 directory goes; the fp32 model the reader speaks with stays.
    expect(native.deleted).toEqual(['int8']);
  });

  it('asks for the fp32 download on a phone that only has the INT8 build', async () => {
    // A v0.3.3 user who deleted fp32: the plugin still answers downloaded (it falls back),
    // but the fp32 entry says otherwise, so the panel must offer the full model.
    native.status = () =>
      Promise.resolve({
        downloaded: true,
        loaded: true,
        sizeBytes: 126_000_000,
        model: 'int8',
        archiveBytes: 132_353_410,
        models: [
          { key: 'int8', downloaded: true, archiveBytes: 132_353_410 },
          { key: 'fp32', downloaded: false, archiveBytes: 349_886_476 },
        ],
      });

    const shown = await render();

    expect(shown).toContain('Download model (334 MB)');
    expect(shown).not.toContain('Ready');
    // Nothing to delete: those files are the only model on the phone until fp32 arrives.
    expect(button('Remove the old INT8 download (126 MB)')).toBeUndefined();
  });

  it('names the speakers readably and saves the chosen one to its own setting', async () => {
    native.voices = [
      { id: '3', name: 'af_heart', lang: 'en-US' },
      { id: '4', name: 'am_adam', lang: 'en-US' },
      { id: '6', name: 'bf_emma', lang: 'en-GB' },
      { id: '9', name: 'speaker-from-the-plugin', lang: 'en-US' },
    ];

    await render();

    const select = container.querySelector<HTMLSelectElement>('#kokoro-native-voice');
    expect(select).not.toBeNull();
    expect([...(select?.options ?? [])].map((option) => option.textContent)).toEqual([
      'Heart · American female (en-US)',
      'Adam · American male (en-US)',
      'Emma · British female (en-GB)',
      'speaker-from-the-plugin (en-US)',
    ]);
    // The picker starts on the saved speaker, not on the first option.
    expect(select?.value).toBe('3');

    await act(async () => {
      select!.value = '6';
      select!.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    await waitForSetting('tts.voice.kokoro', '6');
  });

  it('disables the voice test with the reason, until the model is here', async () => {
    await render();

    const test = button('Test voice');
    expect(test).toBeDefined();
    expect(test?.disabled).toBe(true);
    expect(text()).toContain('Download the model first');
  });

  it("speaks a sample with the chosen speaker at the book's rate, and stops on a second tap", async () => {
    native.status = () =>
      Promise.resolve({
        downloaded: true,
        loaded: true,
        sizeBytes: 333_000_000,
        model: 'fp32',
        models: [{ key: 'fp32', downloaded: true, sizeBytes: 333_000_000 }],
      });
    native.voices = [
      { id: '3', name: 'af_heart', lang: 'en-US' },
      { id: '4', name: 'am_adam', lang: 'en-US' },
    ];
    const synthesize = vi.fn(
      async (text: string, opts: { voiceId?: string; rate: number }) => {
        void text;
        void opts;
        return new Blob(['wav']);
      }
    );
    native.synthesize = synthesize;
    await setSetting('tts.rate', 1.3);

    await render();
    const select = container.querySelector<HTMLSelectElement>('#kokoro-native-voice')!;
    await act(async () => {
      select.value = '4';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    await act(async () => {
      button('Test voice')!.click();
    });
    await waitFor(() => synthesize.mock.calls.length === 1);

    const [spoken, options] = synthesize.mock.calls[0]!;
    expect(String(spoken)).toContain('This is how your book will sound');
    expect(options).toEqual({ voiceId: '4', rate: 1.3 });
    // A voice check must never fill the audio cache.
    expect(await db.audioCache.count()).toBe(0);

    await waitFor(() => button('Stop test') !== undefined);
    expect(FakeAudio.instances).toHaveLength(1);
    await act(async () => {
      button('Stop test')!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(native.stops).toBe(1);
    expect(FakeAudio.instances[0]?.paused).toBe(true);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:sample');
  });
});
