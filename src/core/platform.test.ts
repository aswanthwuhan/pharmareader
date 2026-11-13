import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isIos, isStandalone } from './platform';

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 15_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.4 Mobile/15E148 Safari/604.1';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Mobile Safari/537.36';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36';

/** Own properties to delete again, so the jsdom prototype getters come back. */
let shadowed: string[] = [];
let savedMatchMedia: PropertyDescriptor | undefined;

function shadow(key: string, value: unknown): void {
  Object.defineProperty(navigator, key, { configurable: true, value });
  shadowed.push(key);
}

function stubUserAgent(userAgent: string, extra: { platform?: string; maxTouchPoints?: number } = {}): void {
  shadow('userAgent', userAgent);
  shadow('platform', extra.platform ?? 'Linux armv8l');
  shadow('maxTouchPoints', extra.maxTouchPoints ?? 5);
}

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

beforeEach(() => {
  savedMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of shadowed) delete (navigator as unknown as Record<string, unknown>)[key];
  shadowed = [];
  if (savedMatchMedia) Object.defineProperty(window, 'matchMedia', savedMatchMedia);
  else delete (window as { matchMedia?: unknown }).matchMedia;
});

describe('isIos', () => {
  it('is true on iPhone, iPad and iPod', () => {
    stubUserAgent(IPHONE_UA);
    expect(isIos()).toBe(true);

    stubUserAgent(IPAD_UA);
    expect(isIos()).toBe(true);

    stubUserAgent('Mozilla/5.0 (iPod touch; CPU iPhone OS 15_4 like Mac OS X) AppleWebKit/605.1.15');
    expect(isIos()).toBe(true);
  });

  it('is true on iPadOS, which sends a Mac user agent and a touch screen', () => {
    stubUserAgent(DESKTOP_UA.replace('Windows NT 10.0; Win64; x64', 'Intel Mac OS X 10_15_7'), {
      platform: 'MacIntel',
      maxTouchPoints: 5,
    });
    expect(isIos()).toBe(true);
  });

  it('is false on Android, desktop Chrome and a Mac without a touch screen', () => {
    stubUserAgent(ANDROID_UA);
    expect(isIos()).toBe(false);

    stubUserAgent(DESKTOP_UA, { platform: 'Win32', maxTouchPoints: 0 });
    expect(isIos()).toBe(false);

    stubUserAgent(DESKTOP_UA.replace('Windows NT 10.0; Win64; x64', 'Intel Mac OS X 10_15_7'), {
      platform: 'MacIntel',
      maxTouchPoints: 0,
    });
    expect(isIos()).toBe(false);
  });

  it('is false when there is no navigator at all', () => {
    vi.stubGlobal('navigator', undefined);
    expect(isIos()).toBe(false);
  });
});

describe('isStandalone', () => {
  it('is true when the display mode says the app is installed', () => {
    stubStandaloneMedia(true);
    expect(isStandalone()).toBe(true);
  });

  it('is false in an ordinary browser tab', () => {
    stubStandaloneMedia(false);
    stubUserAgent(IPHONE_UA);
    expect(isStandalone()).toBe(false);
  });

  it('is true on iOS Safari’s Home Screen app, which reports navigator.standalone', () => {
    stubStandaloneMedia(false);
    stubUserAgent(IPHONE_UA);
    shadow('standalone', true);
    expect(isStandalone()).toBe(true);
  });

  it('is false when there is no window at all', () => {
    vi.stubGlobal('window', undefined);
    expect(isStandalone()).toBe(false);
  });
});
