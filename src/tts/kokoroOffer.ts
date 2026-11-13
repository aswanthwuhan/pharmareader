/**
 * One place that answers "can this device speak with Kokoro, is it ready, and how do we
 * download it" for the reader (voice sheet, pill, first-Play prompt) and the library
 * banner.
 *
 * The download itself is not new code: native Android runs the same
 * `runKokoroNativeDownload` the Settings panel uses (through `startDownload`), and the
 * web build runs the same prepare-and-measure sequence as `NeuralModelsPanel`. The
 * promise never rejects, and `downloads.ts` keeps it alive after the sheet closes.
 *
 * The native plugin and the registry are imported only when they are used: this module
 * is pulled into the Settings page and the library banner on the web too, where merely
 * registering the native plugin would be wrong (and breaks test doubles).
 */
import { Capacitor } from '@capacitor/core';
import { isIos } from '../core/platform';
import { getSetting, setSetting } from '../core/settings';
import { neuralUnsupportedHint, supportsNeuralVoices } from './capabilities';
import { startDownload } from './downloads';
import { measureRtf } from './neural/benchmark';
import { kokoroEngine, resetKokoroEngine } from './neural/kokoro';

/** Set once the reader has offered Kokoro on its own; the pill and banner stay as ways back. */
export const KOKORO_PROMPTED_SETTING = 'tts.kokoro.prompted';

function isAndroidNative(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export function canRunKokoro(): boolean {
  // The native engine only exists in the Android build; the web worker needs
  // lookbehind + WASM SIMD. An iOS Capacitor build has neither path.
  return isAndroidNative() || (!Capacitor.isNativePlatform() && supportsNeuralVoices());
}

// The iPhone wording lives here so the banner, the sheet and Settings say the same thing.
export const IOS_PHONE_VOICE_WARNING = 'The phone voice may not work on iPhone and iPad.';
export const IOS_PHONE_VOICE_WARNING_TITLE = 'The phone voice may not work on iPhone and iPad';
export const IOS_KOKORO_RECOMMENDATION =
  'Safari does not always start the built-in voice. Kokoro runs inside the app, sounds more natural, and is the recommended voice here.';
export const IOS_KOKORO_SHEET_LINE =
  'The phone voice may not start on iPhone and iPad, so Kokoro is recommended.';
export const VOICE_LIST_POINTER =
  'Every downloadable voice is listed and can be tested in Settings → On-device voice models.';

export interface IosPhoneVoiceNotice {
  title: string;
  body: string;
  /** Kokoro can run on this device, so it is both the recommendation and an action. */
  recommend: boolean;
}

/**
 * The iPhone warning, or `null` off iOS. The phone voice can silently never start in
 * Safari, so Kokoro is the way out — but only where Kokoro can actually run: on older
 * iOS the body is the version hint instead, with no recommendation and no download.
 */
export function iosPhoneVoiceNotice(): IosPhoneVoiceNotice | null {
  if (!isIos()) return null;
  const recommend = canRunKokoro();
  return {
    title: IOS_PHONE_VOICE_WARNING_TITLE,
    body: recommend ? IOS_KOKORO_RECOMMENDATION : neuralUnsupportedHint(),
    recommend,
  };
}

/** True once the model is on disk (and, on the web, loaded into memory). */
export async function kokoroIsReady(): Promise<boolean> {
  try {
    const { kokoroFor } = await import('./registry');
    return await kokoroFor().isReady();
  } catch {
    return false;
  }
}

/**
 * Download Kokoro through the existing path for this platform. Safe to call while
 * another download runs — `startDownload` joins the running promise instead of
 * starting a second one.
 */
export async function startKokoroDownload(): Promise<void> {
  if (isAndroidNative()) {
    const { KOKORO_DOWNLOAD_ID, runKokoroNativeDownload } = await import(
      './native/kokoroDownloadCore'
    );
    await startDownload(KOKORO_DOWNLOAD_ID, runKokoroNativeDownload);
    return;
  }
  // The web engine keeps a partially initialised worker between attempts; start clean.
  resetKokoroEngine();
  await startDownload('kokoro', async (report) => {
    await kokoroEngine.prepare((fraction) => report({ fraction }));
    void measureRtf(kokoroEngine).catch(() => undefined);
  });
}

export async function wasKokoroPrompted(): Promise<boolean> {
  return Boolean(await getSetting<boolean>(KOKORO_PROMPTED_SETTING, false));
}

export async function markKokoroPrompted(): Promise<void> {
  await setSetting(KOKORO_PROMPTED_SETTING, true);
}
