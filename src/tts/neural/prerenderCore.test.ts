import { describe, expect, it, vi } from 'vitest';
import type { AudioCacheRecord, TtsEngine } from '../../core/types';
import { runPrerender, type PrerenderDeps } from './prerenderCore';

const blob = new Blob([new Uint8Array(4)]);

function fakeEngine(stop = vi.fn()): TtsEngine {
  return {
    id: 'pocket',
    label: 'Fake pocket',
    capabilities: { streaming: true, prerender: true, wordBoundaries: false, needsDownload: true },
    isReady: async () => true,
    prepare: async () => {},
    listVoices: async () => [],
    speak: async () => {},
    stop,
    pause: () => {},
    resume: () => {},
    synthesize: vi.fn(async () => blob),
  };
}

function fakeDeps(overrides: Partial<PrerenderDeps> = {}): PrerenderDeps & {
  putAudio: ReturnType<typeof vi.fn>;
  getAudio: ReturnType<typeof vi.fn>;
} {
  const deps = {
    expand: async (text: string) => `expanded:${text}`,
    cacheKey: async (text: string) => `key:${text}`,
    getAudio: vi.fn(async (_key: string) => null as AudioCacheRecord | null),
    putAudio: vi.fn(async (_record: AudioCacheRecord) => undefined),
    durationMs: async () => 1234,
    yield: async () => {},
    ...overrides,
  };
  return deps as PrerenderDeps & { putAudio: ReturnType<typeof vi.fn>; getAudio: ReturnType<typeof vi.fn> };
}

const items = [
  { id: 's1', text: 'one' },
  { id: 's2', text: 'two' },
];

describe('runPrerender', () => {
  it('synthesizes missing items and caches the result', async () => {
    const deps = fakeDeps();
    const progress: number[] = [];
    const report = await runPrerender(fakeEngine(), items, { rate: 1.25 }, (p) => progress.push(p.done), deps);

    expect(report).toMatchObject({ done: 2, synthesised: 2, skipped: 0, failed: 0, aborted: false });
    expect(deps.putAudio).toHaveBeenCalledTimes(2);
    expect(deps.putAudio.mock.calls[0][0]).toMatchObject({
      key: 'key:expanded:one',
      engine: 'pocket',
      durationMs: 1234,
    });
    expect(progress).toEqual([1, 2]);
  });

  it('skips items already in the audio cache', async () => {
    const cached: AudioCacheRecord = { key: 'key:expanded:one', engine: 'pocket', audio: blob, durationMs: 1, createdAt: 0 };
    const deps = fakeDeps({ getAudio: vi.fn(async (key: string) => (key === cached.key ? cached : null)) });
    const engine = fakeEngine();
    const report = await runPrerender(engine, items, {}, undefined, deps);

    expect(report).toMatchObject({ done: 2, synthesised: 1, skipped: 1 });
    expect(deps.putAudio).toHaveBeenCalledTimes(1);
    expect(engine.synthesize).toHaveBeenCalledTimes(1);
  });

  it('stops between items when the signal aborts and reports it', async () => {
    const controller = new AbortController();
    const deps = fakeDeps();
    const engine = fakeEngine();
    deps.putAudio.mockImplementation(async () => {
      controller.abort();
    });

    const report = await runPrerender(engine, items, { signal: controller.signal }, undefined, deps);

    expect(report.aborted).toBe(true);
    expect(report.synthesised).toBe(1);
    expect(report.done).toBe(1);
    expect(engine.stop).toHaveBeenCalled();
  });

  it('does not start at all when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const deps = fakeDeps();
    const report = await runPrerender(fakeEngine(), items, { signal: controller.signal }, undefined, deps);

    expect(report).toMatchObject({ aborted: true, done: 0, synthesised: 0 });
    expect(deps.putAudio).not.toHaveBeenCalled();
  });

  it('continues after a single item fails', async () => {
    const onItemError = vi.fn();
    const deps = fakeDeps({
      expand: vi.fn(async (text: string) => {
        if (text === 'one') throw new Error('bad markup');
        return text;
      }),
      onItemError,
    });
    const report = await runPrerender(fakeEngine(), items, {}, undefined, deps);

    expect(report).toMatchObject({ done: 2, synthesised: 1, failed: 1 });
    expect(onItemError).toHaveBeenCalledTimes(1);
  });

  it('does not count an aborted synthesis as a failed item', async () => {
    const controller = new AbortController();
    const deps = fakeDeps();
    const engine = fakeEngine();
    (engine.synthesize as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      controller.abort();
      throw new Error('Pocket TTS synthesis was stopped');
    });

    const report = await runPrerender(engine, items, { signal: controller.signal }, undefined, deps);

    expect(report).toMatchObject({ aborted: true, failed: 0, done: 0, synthesised: 0 });
    expect(deps.putAudio).not.toHaveBeenCalled();
    expect(engine.stop).toHaveBeenCalled();
  });

  it('stops before synthesizing when the signal aborts during expansion', async () => {
    const controller = new AbortController();
    const deps = fakeDeps({
      expand: vi.fn(async (text: string) => {
        controller.abort();
        return text;
      }),
    });
    const engine = fakeEngine();

    const report = await runPrerender(engine, items, { signal: controller.signal }, undefined, deps);

    expect(report).toMatchObject({ aborted: true, failed: 0, done: 0 });
    expect(engine.synthesize).not.toHaveBeenCalled();
  });

  it('stops before synthesizing when the signal aborts while reading the cache', async () => {
    const controller = new AbortController();
    const deps = fakeDeps({
      getAudio: vi.fn(async () => {
        controller.abort();
        return null;
      }),
    });
    const engine = fakeEngine();

    const report = await runPrerender(engine, items, { signal: controller.signal }, undefined, deps);

    expect(report).toMatchObject({ aborted: true, failed: 0, done: 0 });
    expect(engine.synthesize).not.toHaveBeenCalled();
    expect(deps.putAudio).not.toHaveBeenCalled();
  });

  it('retries an item the engine cancelled once', async () => {
    // Kokoro native shares one cancel epoch between playback and pre-render, so
    // a cancel can belong to playback; one retry is cheaper than a hole.
    const engine = fakeEngine();
    let cancels = 1;
    (engine.synthesize as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      if (cancels > 0) {
        cancels--;
        throw new Error('Job was cancelled');
      }
      return blob;
    });

    const report = await runPrerender(engine, items, {}, undefined, fakeDeps());

    expect(report).toMatchObject({ done: 2, synthesised: 2, failed: 0 });
    expect(engine.synthesize).toHaveBeenCalledTimes(3); // s1, s2 cancelled, s2 retried
  });

  it('counts an item failed when the cancel repeats', async () => {
    const engine = fakeEngine();
    (engine.synthesize as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error('cancelled');
    });
    const onItemError = vi.fn();

    const report = await runPrerender(engine, items, {}, undefined, fakeDeps({ onItemError }));

    expect(report).toMatchObject({ done: 2, synthesised: 0, failed: 2 });
    expect(engine.synthesize).toHaveBeenCalledTimes(4); // exactly one retry per item
    expect(onItemError).toHaveBeenCalledTimes(2);
  });

  it('does not retry a cancel that came with our own abort', async () => {
    const controller = new AbortController();
    const engine = fakeEngine();
    (engine.synthesize as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      controller.abort();
      throw new Error('cancelled');
    });

    const report = await runPrerender(engine, items, { signal: controller.signal }, undefined, fakeDeps());

    expect(report).toMatchObject({ aborted: true, failed: 0 });
    expect(engine.synthesize).toHaveBeenCalledTimes(1);
  });

  it('does not retry a failure that is not a cancel', async () => {
    const engine = fakeEngine();
    (engine.synthesize as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error('model not loaded');
    });

    const report = await runPrerender(engine, items, {}, undefined, fakeDeps());

    expect(report).toMatchObject({ failed: 2 });
    expect(engine.synthesize).toHaveBeenCalledTimes(2);
  });

  it('passes the engine id to the lexicon', async () => {
    const expand = vi.fn(async (text: string) => text);
    await runPrerender(fakeEngine(), items, {}, undefined, fakeDeps({ expand }));

    expect(expand).toHaveBeenCalledWith('one', 'pocket');
    expect(expand).toHaveBeenCalledWith('two', 'pocket');
  });

  it('puts the engine cache variant in the key, matching playback', async () => {
    // Kokoro's voice and precision change the sound, so the pre-render must key the same
    // way the player does or playback would never find these clips.
    const variant = vi.fn(() => 'q8');
    const engine = { ...fakeEngine(), id: 'kokoro' as const, cacheVariant: variant };
    const cacheKey = vi.fn(async () => 'key');

    await runPrerender(engine, [items[0]!], { voiceId: 'af_heart', rate: 1 }, undefined, fakeDeps({ cacheKey }));

    expect(cacheKey).toHaveBeenCalledWith('expanded:one', 'kokoro', 'af_heart@q8', 1);
    // The engine resolves the voice it will really speak with from this, exactly as
    // `synthesize()` gets it — the player passes the same request voice.
    expect(variant).toHaveBeenCalledWith('af_heart');
  });

  it('refuses engines that cannot synthesize', async () => {
    const engine = { ...fakeEngine(), synthesize: undefined } as unknown as TtsEngine;
    await expect(runPrerender(engine, items, {}, undefined, fakeDeps())).rejects.toThrow(/cannot pre-render/);
  });
});
