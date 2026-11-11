/**
 * Full-screen (immersive) reading on Android: hides the status and navigation bars through
 * the native `SystemUi` plugin. The Android WebView ignores the web Fullscreen API
 * (Capacitor's BridgeWebChromeClient has no custom-view support), so the bars can only be
 * hidden from the activity; `SystemUiPlugin.setImmersive` does it with
 * `WindowInsetsControllerCompat`.
 *
 * On the web and desktop this falls back to `document.documentElement.requestFullscreen()`
 * where the browser allows it. Immersive mode is a preference, not a requirement, so nothing
 * here ever throws: a refusal (no user gesture, an iframe without `allowfullscreen`, an old
 * APK that predates the plugin) is logged and the page simply stays as it is. The call does
 * report what happened, though: `false` means the platform refused, and the reader can then
 * keep its own chrome on instead of leaving the user with no way back.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

interface SystemUiPluginApi {
  setImmersive(options: { on: boolean }): Promise<void>;
}

const SystemUi = registerPlugin<SystemUiPluginApi>('SystemUi');

/** The plugin only exists in the Android build (see SystemUiPlugin.java). */
function isAndroid(): boolean {
  try {
    return Capacitor.getPlatform() === 'android';
  } catch {
    // A partial Capacitor mock (some tests, some embeddings) must not break the reader.
    return false;
  }
}

async function setWebFullscreen(on: boolean): Promise<void> {
  const root = document.documentElement;
  if (on) {
    // jsdom and older browsers have no Fullscreen API at all.
    if (typeof root.requestFullscreen !== 'function' || document.fullscreenElement) {
      return;
    }
    await root.requestFullscreen();
    return;
  }
  if (!document.fullscreenElement || typeof document.exitFullscreen !== 'function') {
    return;
  }
  await document.exitFullscreen();
}

/**
 * Calls run one after another, never at the same time. `requestFullscreen()` only
 * resolves once the browser has finished entering, so a quick enter→leave pair used
 * to race: the leave saw `document.fullscreenElement` still null, returned early,
 * and the page stayed full screen while the reader believed it was not. The native
 * plugin is queued too, so both platforms end up doing the last thing that was asked
 * for, whatever the order the answers arrive in.
 */
let queue: Promise<void> = Promise.resolve();

/**
 * Resolves `true` when the platform took the request and `false` when it refused it; it never
 * rejects. A failed call is the difference between "the bars really are hidden" and "the app
 * looks full screen but is not", which the reader has to know to stay usable.
 */
export async function setImmersive(on: boolean): Promise<boolean> {
  const step = async (): Promise<boolean> => {
    try {
      if (isAndroid()) {
        await SystemUi.setImmersive({ on });
      } else {
        await setWebFullscreen(on);
      }
      return true;
    } catch (error) {
      console.warn('[fullscreen] could not switch the immersive mode', error);
      return false;
    }
  };
  const run = queue.then(step, step);
  // The queue only has to know when the previous call has settled: whether it succeeded
  // is the caller's business, not the next call's, so a refusal must not wedge the queue.
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}
