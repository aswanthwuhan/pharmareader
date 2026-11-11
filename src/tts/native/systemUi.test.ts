import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The native module is registered at import time, so the bridge is mocked before that import
// and every call reads the platform from here: that is how the web and Android paths are
// exercised against the same module instance.
const h = vi.hoisted(() => {
  const bridge = {
    setImmersive: vi.fn(async (_options: { on: boolean }) => undefined),
  };
  const registerPlugin = vi.fn((_name: string) => bridge);
  // Plain array, not a mock: the plugin is registered while the module is first imported,
  // which is before any test runs, and mock call history starts empty at that point.
  const registeredNames: string[] = [];
  const platform = { value: 'web' };
  return { bridge, registerPlugin, registeredNames, platform };
});

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => h.platform.value, isNativePlatform: () => true },
  registerPlugin: (name: string) => {
    h.registeredNames.push(name);
    return h.registerPlugin(name);
  },
}));

const { setImmersive } = await import('./systemUi');

/**
 * jsdom has no Fullscreen API at all, which is also exactly the "browser does not support it"
 * case, so each test installs only the pieces it needs and the hooks below take them away
 * again.
 */
function stubRequestFullscreen(impl: () => Promise<void>): void {
  Object.defineProperty(document.documentElement, 'requestFullscreen', {
    configurable: true,
    writable: true,
    value: impl,
  });
}

function stubExitFullscreen(impl: () => Promise<void>): void {
  Object.defineProperty(document, 'exitFullscreen', {
    configurable: true,
    writable: true,
    value: impl,
  });
}

function stubFullscreenElement(element: Element | null): void {
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => element,
  });
}

function removeStubs(): void {
  delete (document.documentElement as unknown as { requestFullscreen?: unknown })
    .requestFullscreen;
  delete (document as unknown as { exitFullscreen?: unknown }).exitFullscreen;
  delete (document as unknown as { fullscreenElement?: unknown }).fullscreenElement;
}

describe('systemUi', () => {
  beforeEach(() => {
    h.platform.value = 'android';
    h.bridge.setImmersive.mockClear();
    h.bridge.setImmersive.mockResolvedValue(undefined);
  });

  afterEach(() => {
    removeStubs();
    vi.restoreAllMocks();
  });

  it('registers the native plugin under the name SystemUi', () => {
    expect(h.registeredNames).toEqual(['SystemUi']);
  });

  describe('outside Android', () => {
    beforeEach(() => {
      h.platform.value = 'web';
    });

    it('requests fullscreen on the document element when the API is available', async () => {
      const request = vi.fn(async () => undefined);
      stubRequestFullscreen(request);

      await expect(setImmersive(true)).resolves.toBe(true);
      expect(request).toHaveBeenCalledTimes(1);
      expect(h.bridge.setImmersive).not.toHaveBeenCalled();
    });

    it('leaves the page alone when the browser has no Fullscreen API', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(setImmersive(true)).resolves.toBe(true);
      await expect(setImmersive(false)).resolves.toBe(true);
      expect(warn).not.toHaveBeenCalled();
    });

    it('does not ask for fullscreen twice', async () => {
      const request = vi.fn(async () => undefined);
      stubRequestFullscreen(request);
      stubFullscreenElement(document.body);

      await setImmersive(true);
      expect(request).not.toHaveBeenCalled();
    });

    it('leaves the page when a leave arrives while entering is still in flight', async () => {
      // The browser reports the element only when the transition has finished, which is
      // how a quick enter→leave used to leave the page full screen: the leave looked at
      // `fullscreenElement` too early, returned, and nobody ever exited.
      let finishEntering: (() => void) | undefined;
      stubRequestFullscreen(
        () =>
          new Promise<void>((resolve) => {
            finishEntering = () => {
              stubFullscreenElement(document.body);
              resolve();
            };
          })
      );
      stubFullscreenElement(null);
      const exit = vi.fn(async () => {
        stubFullscreenElement(null);
      });
      stubExitFullscreen(exit);

      const entering = setImmersive(true);
      const leaving = setImmersive(false);
      await Promise.resolve();
      expect(exit).not.toHaveBeenCalled();

      finishEntering?.();
      await Promise.all([entering, leaving]);
      expect(exit).toHaveBeenCalledTimes(1);
    });

    it('exits fullscreen when the page is fullscreen', async () => {
      const exit = vi.fn(async () => undefined);
      stubFullscreenElement(document.body);
      stubExitFullscreen(exit);

      await setImmersive(false);
      expect(exit).toHaveBeenCalledTimes(1);
    });

    it('does not try to exit fullscreen when the page is not', async () => {
      const exit = vi.fn(async () => undefined);
      stubExitFullscreen(exit);
      stubFullscreenElement(null);

      await setImmersive(false);
      expect(exit).not.toHaveBeenCalled();
    });

    it('swallows a refused fullscreen request (no user gesture, a sandboxed frame)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      stubRequestFullscreen(async () => {
        throw new Error('requestFullscreen requires a user gesture');
      });

      await expect(setImmersive(true)).resolves.toBe(false);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[fullscreen] could not switch'),
        expect.any(Error)
      );
    });

    it('swallows a refused exit', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      stubFullscreenElement(document.body);
      stubExitFullscreen(async () => {
        throw new Error('not in fullscreen');
      });

      await expect(setImmersive(false)).resolves.toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('on Android', () => {
    it('forwards both directions to the native plugin', async () => {
      await expect(setImmersive(true)).resolves.toBe(true);
      expect(h.bridge.setImmersive).toHaveBeenCalledWith({ on: true });

      await expect(setImmersive(false)).resolves.toBe(true);
      expect(h.bridge.setImmersive).toHaveBeenLastCalledWith({ on: false });
    });

    it('never uses the web Fullscreen API', async () => {
      const request = vi.fn(async () => undefined);
      stubRequestFullscreen(request);

      await setImmersive(true);
      expect(request).not.toHaveBeenCalled();
    });

    it('keeps the native calls in order when they arrive back to back', async () => {
      const calls: boolean[] = [];
      let finishEntering: (() => void) | undefined;
      h.bridge.setImmersive.mockImplementation(async ({ on }: { on: boolean }) => {
        calls.push(on);
        if (on) {
          await new Promise<void>((resolve) => {
            finishEntering = resolve;
          });
        }
      });

      const entering = setImmersive(true);
      const leaving = setImmersive(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
      // The leave waits behind the enter instead of overtaking it.
      expect(calls).toEqual([true]);

      finishEntering?.();
      await Promise.all([entering, leaving]);
      expect(calls).toEqual([true, false]);
    });

    it('swallows a plugin failure, e.g. an APK from before the plugin existed', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      h.bridge.setImmersive.mockRejectedValueOnce(new Error('SystemUi is not implemented'));

      await expect(setImmersive(true)).resolves.toBe(false);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[fullscreen] could not switch'),
        expect.any(Error)
      );
    });

    it('reports a refusal as false and leaves the queue ready for the next call', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      h.bridge.setImmersive.mockRejectedValueOnce(new Error('SystemUi is not implemented'));

      await expect(setImmersive(true)).resolves.toBe(false);
      // The refusal must not count as "still entering": the next call has to go through.
      await expect(setImmersive(false)).resolves.toBe(true);
      expect(h.bridge.setImmersive).toHaveBeenCalledTimes(2);
      expect(h.bridge.setImmersive).toHaveBeenLastCalledWith({ on: false });
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });
});
