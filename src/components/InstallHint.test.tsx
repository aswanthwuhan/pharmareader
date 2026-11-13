import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../core/db';
import { getSetting } from '../core/settings';
import InstallHint, { INSTALL_HINT_DISMISSED_KEY } from './InstallHint';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Mobile Safari/537.36';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let shadowed: string[] = [];
let savedMatchMedia: PropertyDescriptor | undefined;

function shadow(key: string, value: unknown): void {
  Object.defineProperty(navigator, key, { configurable: true, value });
  shadowed.push(key);
}

/** jsdom has no matchMedia, and the component reads the display mode through it. */
function stubStandaloneMedia(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      media: query,
      matches,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

async function flush(ms = 10): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<InstallHint />);
  });
  await flush();
}

function banner(): HTMLElement | null {
  return container?.querySelector<HTMLElement>('.banner') ?? null;
}

beforeEach(() => {
  savedMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (root) {
    await act(async () => {
      root?.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
  for (const key of shadowed) delete (navigator as unknown as Record<string, unknown>)[key];
  shadowed = [];
  if (savedMatchMedia) Object.defineProperty(window, 'matchMedia', savedMatchMedia);
  else delete (window as { matchMedia?: unknown }).matchMedia;
  await db.settings.clear();
});

describe('InstallHint', () => {
  it('tells an iPhone reader how to keep the library', async () => {
    shadow('userAgent', IPHONE_UA);
    shadow('platform', 'iPhone');
    stubStandaloneMedia(false);
    await mount();

    const hint = banner();
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toContain('Safari deletes your library if you don’t open PharmaReader for 7 days');
    expect(hint?.textContent).toContain('Add to Home Screen');
    expect(hint?.querySelector('p.banner-title')?.textContent).toBe('Keep your library on this iPhone');
    expect(hint?.querySelector<HTMLButtonElement>('button')?.getAttribute('aria-label')).toBe('Dismiss');
  });

  it('stays away once the app is on the Home Screen', async () => {
    shadow('userAgent', IPHONE_UA);
    shadow('platform', 'iPhone');
    stubStandaloneMedia(true);
    await mount();
    expect(banner()).toBeNull();
  });

  it('stays away on Android and desktop', async () => {
    shadow('userAgent', ANDROID_UA);
    shadow('platform', 'Linux armv8l');
    stubStandaloneMedia(false);
    await mount();
    expect(banner()).toBeNull();
  });

  it('stays away when the reader dismissed it before', async () => {
    shadow('userAgent', IPHONE_UA);
    shadow('platform', 'iPhone');
    stubStandaloneMedia(false);
    await db.settings.put({ key: INSTALL_HINT_DISMISSED_KEY, value: true });

    await mount();
    // The stored answer is read after mount: wait for it, then it must stay gone.
    await flush();
    expect(banner()).toBeNull();
  });

  it('hides itself and remembers the dismissal', async () => {
    shadow('userAgent', IPHONE_UA);
    shadow('platform', 'iPhone');
    stubStandaloneMedia(false);
    await mount();

    const button = banner()?.querySelector<HTMLButtonElement>('button');
    await act(async () => {
      button?.click();
    });
    await flush();

    expect(banner()).toBeNull();
    expect(await getSetting(INSTALL_HINT_DISMISSED_KEY, false)).toBe(true);
  });
});
