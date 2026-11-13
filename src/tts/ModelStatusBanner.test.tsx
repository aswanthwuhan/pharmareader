import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../core/db';
import { getSetting, setSetting } from '../core/settings';
import { resetDownload, startDownload } from './downloads';
import ModelStatusBanner from './ModelStatusBanner';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Which voices exist is a device fact; the harness below decides it per test.
const harness = vi.hoisted(() => {
  const state = {
    pocketReady: false,
    kokoroReady: false,
    preferred: false,
    native: false,
    platform: 'android',
    voices: [] as unknown[],
  };

  function engine(id: 'system' | 'pocket' | 'kokoro', label: string) {
    return {
      id,
      label,
      capabilities: { streaming: true, prerender: true, wordBoundaries: true, needsDownload: false },
      isReady: async () => {
        if (id === 'pocket') return state.pocketReady;
        if (id === 'kokoro') return state.kokoroReady;
        return true;
      },
      prepare: async () => undefined,
      listVoices: async () => (id === 'system' ? state.voices : []),
      speak: async () => undefined,
      stop() {},
      pause() {},
      resume() {},
    };
  }

  const engines = {
    system: engine('system', 'System voices'),
    pocket: engine('pocket', 'Pocket TTS (on device)'),
    kokoro: engine('kokoro', 'Kokoro (on device)'),
  };
  return { state, engines };
});

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => harness.state.native,
    getPlatform: () => harness.state.platform,
  },
}));

vi.mock('./registry', () => ({
  ENGINE_SETTING: 'tts.engine',
  allEngines: () => [harness.engines.system, harness.engines.pocket, harness.engines.kokoro],
  kokoroFor: () => harness.engines.kokoro,
  describeEngine: async () => ({ engine: harness.engines.system, preferred: harness.state.preferred }),
}));

vi.mock('./neural/benchmark', () => ({
  rtfSettingKey: (id: string) => `tts.rtf.${id}`,
}));

let container: HTMLDivElement;
let root: Root | null = null;

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitFor(check: () => boolean, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) {
    await flush(25);
  }
}

async function mount(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={['/']}>
        <ModelStatusBanner context="reader" />
      </MemoryRouter>,
    );
  });
  // The probe runs after paint; settle it before asserting.
  await flush(20);
  return container;
}

async function unmount(): Promise<void> {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  container.remove();
}

/** A download that is still running, so the banner has progress to show. */
function runningDownload(id: 'pocket' | 'kokoro', fraction: number): {
  finish: () => void;
  task: Promise<void>;
} {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const task = startDownload(id, async (report) => {
    report({ fraction });
    await gate;
  });
  return { finish, task };
}

beforeEach(() => {
  harness.state.pocketReady = false;
  harness.state.kokoroReady = false;
  harness.state.preferred = false;
  harness.state.native = false;
  harness.state.platform = 'android';
  harness.state.voices = [];
  useUserAgent(DESKTOP_UA);
});

afterEach(async () => {
  await unmount();
  resetDownload('pocket');
  resetDownload('kokoro');
  await flush(10);
  await db.delete();
  await db.open();
});

// `isIos()` reads the user agent, so an iPhone is a property of the test, not of jsdom.
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const DESKTOP_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function useUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true });
}

describe('ModelStatusBanner', () => {
  it('warns when the chosen model is missing and names the built-in voice fallback', async () => {
    harness.state.preferred = false;
    await setSetting('tts.engine', 'pocket');
    const view = await mount();

    const banner = view.querySelector('.banner-warning');
    expect(banner).not.toBeNull();
    expect(banner!.getAttribute('role')).toBe('status');
    // Only the tip is marked: a warning must stay visible even on a short screen.
    expect(banner!.getAttribute('data-dismissible')).toBeNull();
    expect(banner!.textContent).toContain(
      "Pocket TTS voice isn't downloaded yet — reading with the phone's built-in voice.",
    );
    const link = banner!.querySelector('a');
    expect(link?.textContent).toBe('Download in Settings');
    expect(link?.getAttribute('href')).toBe('/settings#voice-models');
  });

  it('names Kokoro in the warning when Kokoro is the chosen model', async () => {
    harness.state.preferred = false;
    await setSetting('tts.engine', 'kokoro');
    const view = await mount();

    expect(view.querySelector('.banner-warning')?.textContent).toContain(
      "Kokoro voice isn't downloaded yet",
    );
  });

  it('says nothing when the chosen model is installed', async () => {
    harness.state.kokoroReady = true;
    harness.state.preferred = true;
    await setSetting('tts.engine', 'kokoro');
    const view = await mount();

    expect(view.querySelector('.banner')).toBeNull();
  });

  it('offers the download once under auto, and remembers the dismissal', async () => {
    await setSetting('tts.engine', 'auto');
    const view = await mount();

    const banner = view.querySelector('.banner-info');
    expect(banner).not.toBeNull();
    // The iPhone headline belongs to the iPhone only.
    expect(banner!.querySelector('.banner-title')).toBeNull();
    // The reader's short-window query hides the tip by this attribute.
    expect(banner!.getAttribute('data-dismissible')).toBe('true');
    expect(banner!.textContent).toContain(
      "Using your phone's built-in voice. Kokoro is higher quality and sounds more natural — download it once, and it works offline.",
    );

    const dismiss = banner!.querySelector<HTMLButtonElement>('button[aria-label="Dismiss tip"]');
    expect(dismiss).not.toBeNull();
    await act(async () => {
      dismiss!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => view.querySelector('.banner') === null);
    expect(view.querySelector('.banner')).toBeNull();
    expect(await getSetting('ui.dismiss.noModelTip', false)).toBe(true);

    // A later mount stays quiet: the tip is a one-time teaching sentence.
    await unmount();
    const again = await mount();
    expect(again.querySelector('.banner')).toBeNull();
  });

  it('shows the running download instead of the missing-voice warning', async () => {
    await setSetting('tts.engine', 'pocket');
    const running = runningDownload('pocket', 0.42);
    const view = await mount();

    expect(view.querySelector('.banner-warning')).toBeNull();
    expect(view.querySelector('.banner-info')?.textContent).toContain('Downloading Pocket TTS — 42%');
    expect(view.querySelector('.banner-info')?.textContent).toContain('See the download in Settings');

    await act(async () => running.finish());
    await running.task;
    await flush(20);
    // Ended but not installed yet: the ordinary probe takes over again.
    expect(view.querySelector('.banner-warning')?.textContent).toContain(
      "Pocket TTS voice isn't downloaded yet",
    );
  });

  it('follows a running download even when the choice is Auto', async () => {
    await setSetting('tts.engine', 'auto');
    const running = runningDownload('kokoro', 0.2);
    const view = await mount();

    const banner = view.querySelector('.banner-info');
    expect(banner?.textContent).toContain('Downloading Kokoro — 20%');
    // Not the "go download one" tip while one is already downloading.
    expect(banner?.textContent).not.toContain('Download Kokoro or Pocket TTS in Settings');

    await act(async () => running.finish());
    await running.task;
    await flush(20);
    expect(view.querySelector('.banner-info')?.textContent).toContain(
      "Using your phone's built-in voice.",
    );
  });

  it('asks for a speed measurement when a model is installed but never timed', async () => {
    harness.state.kokoroReady = true;
    harness.state.preferred = true;
    await setSetting('tts.engine', 'auto');
    const view = await mount();

    const banner = view.querySelector('.banner-info');
    expect(banner?.textContent).toContain(
      "Voice model installed — run 'Measure speed' in Settings so Auto can use it.",
    );
    expect(banner?.querySelector('button')).toBeNull();
  });

  it('stays quiet under auto once a model is installed and measured', async () => {
    harness.state.kokoroReady = true;
    harness.state.preferred = true;
    await setSetting('tts.engine', 'auto');
    await setSetting('tts.rtf.kokoro', 0.62);
    const view = await mount();

    expect(view.querySelector('.banner')).toBeNull();
  });

  it('reports a phone with no speech engine at all as an error', async () => {
    harness.state.native = true;
    harness.state.preferred = false;
    harness.state.voices = [];
    await setSetting('tts.engine', 'system');
    const view = await mount();

    const banner = view.querySelector('.banner-error');
    expect(banner).not.toBeNull();
    expect(banner!.getAttribute('role')).toBe('alert');
    expect(banner!.textContent).toContain(
      "No text-to-speech engine found on this phone. Install 'Speech Services by Google' from the Play Store.",
    );
    // An install hint cannot be dismissed away.
    expect(banner!.querySelector('button')).toBeNull();
  });

  it('does not claim a missing engine on the web build', async () => {
    harness.state.native = false;
    harness.state.voices = [];
    await setSetting('tts.engine', 'system');
    const view = await mount();

    expect(view.querySelector('.banner-error')).toBeNull();
  });

  it('warns an iPhone that the phone voice may not work, and offers Kokoro', async () => {
    useUserAgent(IPHONE_UA);
    await setSetting('tts.engine', 'auto');
    const view = await mount();

    // Never the dismissible tip: the reader hides those in Page view and short windows.
    expect(view.querySelector('.banner-info')).toBeNull();
    const banner = view.querySelector('.banner-warning');
    expect(banner).not.toBeNull();
    expect(banner!.querySelector('.banner-title')?.textContent).toBe(
      'The phone voice may not work on iPhone and iPad',
    );
    expect(banner!.textContent).toContain(
      'Safari does not always start the built-in voice. Kokoro runs inside the app, sounds more natural, and is the recommended voice here.',
    );
    expect(banner!.getAttribute('data-dismissible')).toBeNull();
    expect(banner!.querySelector('button[aria-label="Dismiss tip"]')).toBeNull();
    expect(banner!.textContent).toContain(
      'Every downloadable voice is listed and can be tested in Settings → On-device voice models.',
    );

    // The action opens the Kokoro sheet instead of leaving the page.
    const action = banner!.querySelector<HTMLButtonElement>('button.rd-banner-link');
    expect(action?.textContent).toBe('Download Kokoro');
    await act(async () => {
      action!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(view.querySelector('.voice-prompt')).not.toBeNull();
  });

  it('warns on an iPhone when the System voices are the chosen engine', async () => {
    useUserAgent(IPHONE_UA);
    await setSetting('tts.engine', 'system');
    const view = await mount();

    const banner = view.querySelector('.banner-warning');
    expect(banner?.querySelector('.banner-title')?.textContent).toBe(
      'The phone voice may not work on iPhone and iPad',
    );
    expect(banner?.getAttribute('data-dismissible')).toBeNull();
  });

  it('asks for a newer iOS instead of offering Kokoro where it cannot run', async () => {
    useUserAgent(IPHONE_UA);
    // A native iOS shell has no Kokoro engine, which is also what an older Safari
    // reports (no lookbehind, no SIMD): the same gate decides both.
    harness.state.native = true;
    harness.state.platform = 'ios';
    await setSetting('tts.engine', 'system');
    const view = await mount();

    const banner = view.querySelector('.banner-warning');
    expect(banner).not.toBeNull();
    expect(banner!.querySelector('.banner-title')?.textContent).toBe(
      'The phone voice may not work on iPhone and iPad',
    );
    expect(banner!.textContent).toContain(
      "Needs iOS 16.4 or newer — your phone's built-in voice still works.",
    );
    expect(banner!.textContent).not.toContain('Download Kokoro');
    expect(banner!.querySelector('button')).toBeNull();
    expect(banner!.getAttribute('data-dismissible')).toBeNull();
  });

  it('says nothing on an iPhone once Kokoro is the engine', async () => {
    useUserAgent(IPHONE_UA);
    harness.state.kokoroReady = true;
    harness.state.preferred = true;
    await setSetting('tts.engine', 'kokoro');
    const view = await mount();

    expect(view.querySelector('.banner')).toBeNull();
  });
});
