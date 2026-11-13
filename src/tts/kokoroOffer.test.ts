import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../core/db';
import { getSetting } from '../core/settings';
import { getDownload, resetDownload } from './downloads';
import {
  IOS_KOKORO_RECOMMENDATION,
  IOS_PHONE_VOICE_WARNING_TITLE,
  KOKORO_PROMPTED_SETTING,
  canRunKokoro,
  iosPhoneVoiceNotice,
  kokoroIsReady,
  markKokoroPrompted,
  startKokoroDownload,
  wasKokoroPrompted,
} from './kokoroOffer';

const platform = vi.hoisted(() => ({ native: false, android: false }));
const caps = vi.hoisted(() => ({ neural: true }));

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const DESKTOP_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** `isIos()` reads the user agent; shadow it the way the other tests do. */
function useUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true });
}
const engine = vi.hoisted(() => ({
  ready: false,
  prepare: vi.fn(async () => undefined),
  reset: vi.fn(),
}));
const nativeCore = vi.hoisted(() => ({ run: vi.fn(async () => undefined) }));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => platform.native,
    getPlatform: () => (platform.android ? 'android' : 'web'),
  },
}));
vi.mock('./capabilities', () => ({
  supportsNeuralVoices: () => caps.neural,
  neuralUnsupportedHint: () => "Needs iOS 16.4 or newer — your phone's built-in voice still works.",
}));
vi.mock('./neural/kokoro', () => ({
  kokoroEngine: { prepare: engine.prepare },
  resetKokoroEngine: engine.reset,
}));
vi.mock('./registry', () => ({
  kokoroFor: () => ({ isReady: async () => engine.ready }),
}));
vi.mock('./native/kokoroDownloadCore', () => ({
  KOKORO_DOWNLOAD_ID: 'kokoro',
  runKokoroNativeDownload: nativeCore.run,
}));
beforeEach(() => {
  platform.native = false;
  platform.android = false;
  caps.neural = true;
  engine.ready = false;
  useUserAgent(DESKTOP_UA);
  engine.prepare.mockClear();
  engine.reset.mockClear();
  nativeCore.run.mockClear();
  resetDownload('kokoro');
});

afterEach(async () => {
  resetDownload('kokoro');
  await db.delete();
  await db.open();
});

describe('kokoroOffer', () => {
  it('allows Kokoro on the web only when the device can run the worker', () => {
    expect(canRunKokoro()).toBe(true);
    caps.neural = false;
    expect(canRunKokoro()).toBe(false);
    // The Android shell, on the other hand, always has the native engine.
    platform.native = true;
    platform.android = true;
    expect(canRunKokoro()).toBe(true);
    // An iOS shell has no engine mapping for Kokoro, so it must never be offered.
    platform.android = false;
    caps.neural = true;
    expect(canRunKokoro()).toBe(false);
  });

  it('remembers that Kokoro was offered, so the first Play asks only once', async () => {
    expect(await wasKokoroPrompted()).toBe(false);
    await markKokoroPrompted();
    expect(await wasKokoroPrompted()).toBe(true);
    expect(await getSetting(KOKORO_PROMPTED_SETTING, false)).toBe(true);
  });

  it('reports readiness through the registry engine', async () => {
    expect(await kokoroIsReady()).toBe(false);
    engine.ready = true;
    expect(await kokoroIsReady()).toBe(true);
  });

  it('runs the same web download as Settings, starting from a clean worker', async () => {
    await startKokoroDownload();
    expect(engine.reset).toHaveBeenCalledTimes(1);
    expect(engine.prepare).toHaveBeenCalledTimes(1);
    expect(getDownload('kokoro').status).toBe('done');
    expect(nativeCore.run).not.toHaveBeenCalled();
  });

  it('joins the native Android download instead of starting another one', async () => {
    platform.native = true;
    platform.android = true;
    await startKokoroDownload();
    expect(nativeCore.run).toHaveBeenCalledTimes(1);
    expect(engine.prepare).not.toHaveBeenCalled();
  });

  it('keeps the promise from rejecting when the download fails', async () => {
    engine.prepare.mockRejectedValueOnce(new Error('The connection dropped.'));
    await expect(startKokoroDownload()).resolves.toBeUndefined();
    const failed = getDownload('kokoro');
    expect(failed.status).toBe('error');
    expect(failed.error).toBe('The connection dropped.');
  });
});

describe('iosPhoneVoiceNotice', () => {
  it('says nothing away from iOS', () => {
    useUserAgent(DESKTOP_UA);
    expect(iosPhoneVoiceNotice()).toBeNull();
  });

  it('recommends Kokoro on an iPhone that can run it', () => {
    useUserAgent(IPHONE_UA);
    expect(iosPhoneVoiceNotice()).toEqual({
      title: IOS_PHONE_VOICE_WARNING_TITLE,
      body: IOS_KOKORO_RECOMMENDATION,
      recommend: true,
    });
  });

  it('only warns, with the iOS version needed, where Kokoro cannot run', () => {
    useUserAgent(IPHONE_UA);
    caps.neural = false;
    expect(iosPhoneVoiceNotice()).toEqual({
      title: IOS_PHONE_VOICE_WARNING_TITLE,
      body: "Needs iOS 16.4 or newer — your phone's built-in voice still works.",
      recommend: false,
    });
  });
});


