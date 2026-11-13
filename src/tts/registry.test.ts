import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../core/db';
import { setSetting } from '../core/settings';
import type { TtsEngine } from '../core/types';

// Engines are mocked so the resolution rules can be exercised without models.
const h = vi.hoisted(() => {
  const ready: Record<string, boolean> = {};
  const failing = new Set<string>();
  const native = { value: false };
  /** What the browser can run; false stands for iOS 15.4–16.3. */
  const caps = { supported: true };
  const make = (id: string, label: string): unknown => ({
    id,
    label,
    capabilities: { streaming: true, prerender: false, wordBoundaries: false, needsDownload: false },
    isReady: async () => {
      if (failing.has(id)) throw new Error(`${id} exploded`);
      return ready[id] === true;
    },
    prepare: async () => undefined,
    listVoices: async () => [],
    speak: async () => undefined,
    stop: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
  });
  return { ready, failing, native, caps, make };
});

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => h.native.value },
}));
vi.mock('./capabilities', () => ({ supportsNeuralVoices: () => h.caps.supported }));
vi.mock('./system', () => ({ systemEngine: h.make('system', 'System voices') }));
vi.mock('./neural/pocket', () => ({ pocketEngine: h.make('pocket', 'Pocket TTS') }));
vi.mock('./neural/kokoro', () => ({ kokoroEngine: h.make('kokoro', 'Kokoro (web)') }));
vi.mock('./native/kokoroNativeEngine', () => ({ kokoroNativeEngine: h.make('kokoro', 'Kokoro (native)') }));

const { allEngines, describeEngine, resolveEngine } = await import('./registry');

beforeEach(async () => {
  h.ready.system = true;
  h.ready.pocket = false;
  h.ready.kokoro = false;
  h.failing.clear();
  h.native.value = false;
  h.caps.supported = true;
  await db.delete();
  await db.open();
});

afterEach(async () => {
  await db.delete();
  await db.open();
});

describe('allEngines', () => {
  it('lists the system voice, Pocket TTS and one Kokoro per platform', () => {
    expect(allEngines().map((e) => e.label)).toEqual(['System voices', 'Pocket TTS', 'Kokoro (web)']);
    h.native.value = true;
    expect(allEngines().map((e) => e.label)).toEqual(['System voices', 'Pocket TTS', 'Kokoro (native)']);
  });
});

describe('resolveEngine', () => {
  it('defaults to the system voices when the setting is missing', async () => {
    expect((await resolveEngine()).id).toBe('system');
  });

  it('returns the explicitly chosen engine when it is ready', async () => {
    await setSetting('tts.engine', 'pocket');
    h.ready.pocket = true;
    expect((await resolveEngine()).id).toBe('pocket');
  });

  it('falls back to the system voices when the chosen engine is not ready', async () => {
    await setSetting('tts.engine', 'pocket');
    expect((await resolveEngine()).id).toBe('system');
  });

  it('falls back when readiness probing throws', async () => {
    await setSetting('tts.engine', 'pocket');
    h.ready.pocket = true;
    h.failing.add('pocket');
    expect((await resolveEngine()).id).toBe('system');
  });

  it('auto prefers kokoro over pocket when both are installed and fast', async () => {
    h.ready.kokoro = true;
    h.ready.pocket = true;
    await setSetting('tts.rtf.kokoro', 0.6);
    await setSetting('tts.rtf.pocket', 0.4);
    expect((await resolveEngine()).label).toBe('Kokoro (web)');
  });

  it('auto uses pocket when kokoro is not installed', async () => {
    h.ready.pocket = true;
    await setSetting('tts.rtf.pocket', 0.8);
    expect((await resolveEngine()).id).toBe('pocket');
  });

  it('auto ignores an engine that has never been measured', async () => {
    h.ready.pocket = true;
    expect((await resolveEngine()).id).toBe('system');
  });

  it('auto ignores an engine slower than real time', async () => {
    h.ready.pocket = true;
    await setSetting('tts.rtf.pocket', 1.4);
    expect((await resolveEngine()).id).toBe('system');
  });

  it('auto picks the native Kokoro build on a native platform', async () => {
    h.native.value = true;
    h.ready.kokoro = true;
    await setSetting('tts.rtf.kokoro', 0.5);
    expect((await resolveEngine()).label).toBe('Kokoro (native)');
  });

  it('reports whether a fallback happened', async () => {
    await expect(describeEngine()).resolves.toEqual({ engine: expect.anything(), preferred: false });
    await setSetting('tts.engine', 'pocket');
    h.ready.pocket = true;
    const info = await describeEngine();
    expect(info.engine.id).toBe('pocket');
    expect(info.preferred).toBe(true);
    await setSetting('tts.engine', 'kokoro');
    expect((await describeEngine()).preferred).toBe(false);
  });

  it('auto falls through to pocket when kokoro is installed but too slow', async () => {
    h.ready.kokoro = true;
    h.ready.pocket = true;
    await setSetting('tts.rtf.kokoro', 1.5);
    await setSetting('tts.rtf.pocket', 0.7);
    const info = await describeEngine();
    expect(info.engine.id).toBe('pocket');
    expect(info.preferred).toBe(true);
  });

  it('treats an explicit system choice as preferred, not a fallback', async () => {
    await setSetting('tts.engine', 'system');
    const info = await describeEngine();
    expect(info.engine.id).toBe('system');
    expect(info.preferred).toBe(true);
    expect((await resolveEngine()).id).toBe('system');
  });

  it('types the resolved engines as TtsEngine', async () => {
    const engine: TtsEngine = await resolveEngine();
    expect(typeof engine.speak).toBe('function');
  });
});

describe('a browser without SIMD or lookbehind', () => {
  it('never selects a downloaded voice, not even an explicitly chosen ready one', async () => {
    h.caps.supported = false;
    h.ready.kokoro = true;
    h.ready.pocket = true;
    await setSetting('tts.engine', 'kokoro');
    expect((await resolveEngine()).id).toBe('system');
    await setSetting('tts.engine', 'pocket');
    expect((await resolveEngine()).id).toBe('system');

    // Even a measured, faster-than-real-time model is refused.
    await setSetting('tts.engine', 'auto');
    await setSetting('tts.rtf.kokoro', 0.5);
    await setSetting('tts.rtf.pocket', 0.4);
    const info = await describeEngine();
    expect(info.engine.id).toBe('system');
    expect(info.preferred).toBe(false);
  });

  it("still uses Android's native Kokoro, which does not run in the WebView", async () => {
    h.caps.supported = false;
    h.native.value = true;
    h.ready.kokoro = true;
    h.ready.pocket = true;
    await setSetting('tts.engine', 'kokoro');
    expect((await resolveEngine()).label).toBe('Kokoro (native)');
    await setSetting('tts.engine', 'pocket');
    expect((await resolveEngine()).id).toBe('system');
  });
});
