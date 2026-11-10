/**
 * Bridge to the native `Playback` plugin (Android foreground media service).
 *
 * The service exists for one reason: with the screen locked Android freezes a cached app
 * within a minute, which stops the reader from synthesising the next sentence mid-chapter.
 * A `mediaPlayback` foreground service plus a partial wake lock keep the process alive, and
 * its notification / lock-screen / headset buttons come back here as {@link PlaybackAction}s.
 *
 * Nothing about this is required for reading to work: outside the Android app every call is
 * a resolved no-op, and a plugin error (an old APK, a refused foreground start on Android 12+)
 * is logged and swallowed so playback never breaks because of the service. The audio itself
 * is never played by the service — the WebView's own media stack owns it.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

export interface PlaybackMeta {
  title: string;
  subtitle?: string;
}

export type PlaybackAction = 'play' | 'pause' | 'next' | 'previous' | 'stop';

interface PlaybackPluginApi {
  start(options: { title: string; subtitle?: string }): Promise<void>;
  setState(options: { state: 'playing' | 'paused' }): Promise<void>;
  stop(): Promise<void>;
  addListener(
    eventName: 'action',
    listener: (event: { action: PlaybackAction }) => void
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}

const Playback = registerPlugin<PlaybackPluginApi>('Playback');

const ACTIONS: ReadonlySet<string> = new Set<PlaybackAction>([
  'play',
  'pause',
  'next',
  'previous',
  'stop',
]);

/** The plugin only exists in the Android build (see PlaybackPlugin.java). */
function isAndroid(): boolean {
  try {
    return Capacitor.getPlatform() === 'android';
  } catch {
    // A partial Capacitor mock (some tests, some embeddings) must not break playback.
    return false;
  }
}

function warn(what: string, error: unknown): void {
  console.warn(`[playback] ${what} failed; continuing without the media service`, error);
}

function isPlaybackAction(value: unknown): value is PlaybackAction {
  return typeof value === 'string' && ACTIONS.has(value);
}

export const nativePlayback = {
  /** Start (or refresh) the foreground service in the playing state. */
  async start(meta: PlaybackMeta): Promise<void> {
    if (!isAndroid()) {
      return;
    }
    try {
      await Playback.start({ title: meta.title, subtitle: meta.subtitle ?? '' });
    } catch (error) {
      warn('start', error);
    }
  },

  /** Reflect play/pause in the notification without stopping the service. */
  async setState(state: 'playing' | 'paused'): Promise<void> {
    if (!isAndroid()) {
      return;
    }
    try {
      await Playback.setState({ state });
    } catch (error) {
      warn('setState', error);
    }
  },

  /** Stop the service and remove the notification. */
  async stop(): Promise<void> {
    if (!isAndroid()) {
      return;
    }
    try {
      await Playback.stop();
    } catch (error) {
      warn('stop', error);
    }
  },

  /** Notification / headset / unplug actions. Returns an unsubscribe function. */
  onAction(cb: (action: PlaybackAction) => void): () => void {
    if (!isAndroid()) {
      return () => {};
    }
    let removed = false;
    let handle: PluginListenerHandle | undefined;
    void Playback.addListener('action', (event) => {
      if (removed || !isPlaybackAction(event?.action)) {
        return;
      }
      try {
        cb(event.action);
      } catch (error) {
        // The reader's handler is not allowed to take the media controls down with it.
        console.warn('[playback] action handler threw', error);
      }
    })
      .then((registered) => {
        handle = registered;
        if (removed) {
          // Unsubscribed while the listener was still registering: undo it now.
          void Promise.resolve(registered.remove()).catch((error) =>
            warn('remove listener', error)
          );
        }
      })
      .catch((error) => warn('onAction', error));

    return () => {
      if (removed) {
        return;
      }
      removed = true;
      if (handle) {
        void Promise.resolve(handle.remove()).catch((error) => warn('remove listener', error));
      }
    };
  },
};
