import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The native module is registered at import time, so the bridge is mocked before that import
// and every call reads the platform from here: that is how the web and Android paths are
// exercised against the same module instance.
const h = vi.hoisted(() => {
  const remove = vi.fn(async () => undefined);
  const plugin = {
    start: vi.fn(async () => undefined),
    setState: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    addListener: vi.fn(async (_event: string, _listener: (event: { action: string }) => void) => ({
      remove,
    })),
    removeAllListeners: vi.fn(async () => undefined),
  };
  const registerPlugin = vi.fn((_name: string) => plugin);
  // Plain array, not a mock: the plugin is registered while the module is first imported,
  // which is before any test runs, and mock call history starts empty at that point.
  const registeredNames: string[] = [];
  const platform = { value: 'web' };
  return { plugin, remove, platform, registerPlugin, registeredNames };
});

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => h.platform.value, isNativePlatform: () => true },
  registerPlugin: (name: string) => {
    h.registeredNames.push(name);
    return h.registerPlugin(name);
  },
}));

const { nativePlayback } = await import('./playbackPlugin');

/** The listener the module registered with the plugin. */
async function capturedListener(): Promise<(event: { action: string }) => void> {
  await vi.waitFor(() => expect(h.plugin.addListener).toHaveBeenCalled());
  const listener = h.plugin.addListener.mock.calls.at(-1)?.[1];
  if (!listener) {
    throw new Error('the module did not register an action listener');
  }
  return listener;
}

describe('playbackPlugin', () => {
  beforeEach(() => {
    h.platform.value = 'android';
    for (const fn of [
      h.plugin.start,
      h.plugin.setState,
      h.plugin.stop,
      h.plugin.addListener,
      h.plugin.removeAllListeners,
      h.remove,
    ]) {
      fn.mockClear();
    }
    h.plugin.addListener.mockResolvedValue({ remove: h.remove });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers the native plugin under the name Playback', () => {
    expect(h.registeredNames).toEqual(['Playback']);
  });

  describe('outside Android', () => {
    beforeEach(() => {
      h.platform.value = 'web';
    });

    it('resolves every call without touching the plugin', async () => {
      await expect(nativePlayback.start({ title: 'Chapter 1' })).resolves.toBeUndefined();
      await expect(nativePlayback.setState('playing')).resolves.toBeUndefined();
      await expect(nativePlayback.stop()).resolves.toBeUndefined();

      expect(h.plugin.start).not.toHaveBeenCalled();
      expect(h.plugin.setState).not.toHaveBeenCalled();
      expect(h.plugin.stop).not.toHaveBeenCalled();
      expect(h.plugin.addListener).not.toHaveBeenCalled();
    });

    it('returns a working no-op unsubscribe from onAction', () => {
      const cb = vi.fn();
      const unsubscribe = nativePlayback.onAction(cb);
      expect(unsubscribe).toBeTypeOf('function');
      expect(() => unsubscribe()).not.toThrow();
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('on Android', () => {
    it('starts the service with the title and an empty subtitle by default', async () => {
      await nativePlayback.start({ title: 'Pharmacology, chapter 3' });
      expect(h.plugin.start).toHaveBeenCalledWith({
        title: 'Pharmacology, chapter 3',
        subtitle: '',
      });

      await nativePlayback.start({ title: 'Chapter 4', subtitle: 'Receptors' });
      expect(h.plugin.start).toHaveBeenLastCalledWith({
        title: 'Chapter 4',
        subtitle: 'Receptors',
      });
    });

    it('forwards play and pause states', async () => {
      await nativePlayback.setState('playing');
      expect(h.plugin.setState).toHaveBeenCalledWith({ state: 'playing' });
      await nativePlayback.setState('paused');
      expect(h.plugin.setState).toHaveBeenLastCalledWith({ state: 'paused' });
    });

    it('stops the service', async () => {
      await nativePlayback.stop();
      expect(h.plugin.stop).toHaveBeenCalledTimes(1);
    });

    it('swallows a plugin failure instead of breaking playback', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      h.plugin.start.mockRejectedValueOnce(new Error('foreground start not allowed'));

      await expect(nativePlayback.start({ title: 'Chapter 1' })).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[playback] start failed'),
        expect.any(Error)
      );
    });

    it('never rejects when stopping the service fails', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      h.plugin.stop.mockRejectedValueOnce(new Error('not running'));
      await expect(nativePlayback.stop()).resolves.toBeUndefined();
    });

    it('forwards only known actions to the callback', async () => {
      const cb = vi.fn();
      nativePlayback.onAction(cb);
      const listener = await capturedListener();

      expect(h.plugin.addListener).toHaveBeenCalledWith('action', expect.any(Function));

      listener({ action: 'pause' });
      listener({ action: 'next' });
      expect(cb.mock.calls).toEqual([['pause'], ['next']]);

      // A newer native build with an action this JS does not know must be ignored, not thrown.
      listener({ action: 'seek-forward' });
      listener(undefined as unknown as { action: string });
      expect(cb).toHaveBeenCalledTimes(2);

      expect(h.plugin.addListener).toHaveBeenCalledTimes(1);
    });

    it('keeps a throwing action handler from breaking the media controls', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const cb = vi.fn(() => {
        throw new Error('reader blew up');
      });
      nativePlayback.onAction(cb);
      const listener = await capturedListener();

      expect(() => listener({ action: 'stop' })).not.toThrow();
      expect(warn).toHaveBeenCalledWith('[playback] action handler threw', expect.any(Error));
    });

    it('removes the native listener on unsubscribe, once', async () => {
      const cb = vi.fn();
      const unsubscribe = nativePlayback.onAction(cb);
      const listener = await capturedListener();

      unsubscribe();
      unsubscribe();
      await vi.waitFor(() => expect(h.remove).toHaveBeenCalledTimes(1));

      listener({ action: 'play' });
      expect(cb).not.toHaveBeenCalled();
    });

    it('removes a listener that finished registering after unsubscribe', async () => {
      let resolveRegistration: (handle: { remove: typeof h.remove }) => void = () => {};
      h.plugin.addListener.mockReturnValueOnce(
        new Promise<{ remove: typeof h.remove }>((resolve) => {
          resolveRegistration = resolve;
        })
      );

      const unsubscribe = nativePlayback.onAction(vi.fn());
      await vi.waitFor(() => expect(h.plugin.addListener).toHaveBeenCalledTimes(1));
      unsubscribe();
      expect(h.remove).not.toHaveBeenCalled();

      resolveRegistration({ remove: h.remove });
      await vi.waitFor(() => expect(h.remove).toHaveBeenCalledTimes(1));
    });
  });
});
