// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setModelReady } from './models';
import { ORT_BASE_URL } from './ort';
import {
  POCKET_RATE_MAX,
  POCKET_RATE_MIN,
  clampPocketRate,
  pocketEngine,
  resetPocketEngine,
} from './pocket';

/** Hoisted state shared with the pocket-tts-js mock. */
const lib = vi.hoisted(() => ({
  instance: null as null | { options: Record<string, unknown> },
  stopped: false,
  destroyed: 0,
  /** How many generate() calls were in flight at once (the library allows one). */
  active: 0,
  maxActive: 0,
  empty: false,
}));

vi.mock('pocket-tts-js', () => {
  class PocketTTS {
    ready = false;
    predefinedVoices = ['alba'];
    sampleRate = 24000;
    options: Record<string, unknown>;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      lib.instance = this;
    }

    async load(onProgress: (info: { label: string; loaded: number; total: number }) => void): Promise<void> {
      onProgress({ label: 'flow_lm_main.onnx', loaded: 5, total: 10 });
      await new Promise((resolve) => setTimeout(resolve, 5)); // a real download is slow
      this.ready = true;
    }

    async loadVoice(name: string): Promise<string> {
      return name;
    }

    async generate(
      _text: string,
      opts: { onChunk?: (audio: Float32Array) => void }
    ): Promise<{ rtfx: number; genTime: number; audioDuration: number; stopped?: boolean }> {
      lib.active++;
      lib.maxActive = Math.max(lib.maxActive, lib.active);
      await new Promise((resolve) => setTimeout(resolve, 5)); // inference takes a moment
      if (!lib.empty) opts.onChunk?.(new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]));
      lib.active--;
      return { rtfx: 1, genTime: 1, audioDuration: 1, stopped: lib.stopped };
    }

    async stop(): Promise<void> {}

    destroy(): void {
      lib.destroyed++;
    }
  }
  return { PocketTTS };
});

let startedSources = 0;

class FakeSource {
  buffer: AudioBuffer | null = null;
  playbackRate = { value: 1 };
  onended: (() => void) | null = null;
  connect(): void {}
  disconnect(): void {}
  start(): void {
    startedSources++;
    this.onended?.();
  }
  stop(): void {}
}

class FakeAudioContext {
  state = 'running';
  destination = {};
  createBuffer(_channels: number, length: number): AudioBuffer {
    return { getChannelData: () => new Float32Array(length) } as unknown as AudioBuffer;
  }
  createBufferSource(): AudioBufferSourceNode {
    return new FakeSource() as unknown as AudioBufferSourceNode;
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

beforeEach(() => {
  startedSources = 0;
  lib.instance = null;
  lib.stopped = false;
  lib.destroyed = 0;
  lib.active = 0;
  lib.maxActive = 0;
  lib.empty = false;
  vi.stubGlobal('AudioContext', FakeAudioContext);
});

afterEach(() => {
  resetPocketEngine();
  vi.unstubAllGlobals();
});

describe('pocket rate clamping', () => {
  it('keeps resampling within the range that stays intelligible', () => {
    expect(clampPocketRate(0.5)).toBe(POCKET_RATE_MIN);
    expect(clampPocketRate(2)).toBe(POCKET_RATE_MAX);
    expect(clampPocketRate(1)).toBe(1);
    expect(clampPocketRate(0)).toBe(1);
    expect(clampPocketRate(Number.NaN)).toBe(1);
  });
});

describe('PocketEngine', () => {
  it('points pocket-tts-js at the self-hosted onnxruntime-web build', async () => {
    await pocketEngine.prepare();

    expect(lib.instance?.options.ortBaseUrl).toBe(ORT_BASE_URL);
    expect(ORT_BASE_URL).toBe('/ort/');
  });

  it('shows download progress to a caller that joins an in-flight download', async () => {
    const first: number[] = [];
    const second: number[] = [];
    const a = pocketEngine.prepare((fraction) => first.push(fraction));
    const b = pocketEngine.prepare((fraction) => second.push(fraction));
    await Promise.all([a, b]);

    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    expect(first.at(-1)).toBe(1);
    expect(second.at(-1)).toBe(1);
  });

  it('drops the progress watchers once the model has loaded', async () => {
    const watcher = vi.fn();
    await pocketEngine.prepare(watcher);

    expect(watcher).toHaveBeenCalled();
    // A finished download must not keep the panels' callbacks (and the report
    // function they close over) alive for the rest of the session.
    const listeners = (pocketEngine as unknown as { progressListeners: Set<unknown> })
      .progressListeners;
    expect(listeners.size).toBe(0);
  });

  it('bakes the clamped rate into the synthesised WAV', async () => {
    const blob = await pocketEngine.synthesize!('metformin', { rate: 2 }); // clamped to 1.25
    const bytes = new Uint8Array(await blob.arrayBuffer());

    // 5 samples at 1x -> 4 after 1.25x resampling -> 44-byte header + 8 bytes PCM.
    expect(bytes.length).toBe(44 + 4 * 2);
  });

  it('does not play when stopped while the model is still loading', async () => {
    const spoken = pocketEngine.speak([{ id: 's1', text: 'hello' }], { rate: 1 }, {});
    pocketEngine.stop();
    await spoken;

    expect(startedSources).toBe(0);
  });

  it('serialises overlapping generations', async () => {
    // The player prefetches two sentences ahead; two concurrent generate() calls
    // made pocket-tts-js return an empty clip for the second one, which the
    // reader then "played" in 0 ms — silence, with no error anywhere.
    await pocketEngine.prepare();
    const [first, second] = await Promise.all([
      pocketEngine.synthesize!('first', { rate: 1 }),
      pocketEngine.synthesize!('second', { rate: 1 }),
    ]);

    expect(lib.maxActive).toBe(1);
    expect((await first.arrayBuffer()).byteLength).toBe(44 + 5 * 2);
    expect((await second.arrayBuffer()).byteLength).toBe(44 + 5 * 2);
  });

  it('speaks a long sentence clause by clause, still one sentence to the reader', async () => {
    await pocketEngine.prepare();
    const text =
      'The heart pumps blood through the body without resting, and the lungs add oxygen to that blood before it returns to the heart again, so the cycle can start over.';
    const events: string[] = [];
    await pocketEngine.speak([{ id: 'long', text }], { rate: 1 }, {
      onStart: (id) => events.push(`start:${id}`),
      onEnd: (id) => events.push(`end:${id}`),
    });

    // Several clips played (so audio starts before the whole sentence is rendered)...
    expect(startedSources).toBeGreaterThan(1);
    // ...but the reader still sees exactly one start and one end for the sentence.
    expect(events).toEqual(['start:long', 'end:long']);
  });

  it('fails loudly when the model returns no audio', async () => {
    lib.empty = true;
    await expect(pocketEngine.synthesize!('silence', { rate: 1 })).rejects.toThrow('produced no audio');
  });

  it('rejects synthesis that the library cut short', async () => {
    lib.stopped = true;
    await expect(pocketEngine.synthesize!('metformin', { rate: 1 })).rejects.toThrow('stopped');
  });

  it('still reports ready after a reload when the model is already downloaded', async () => {
    // isReady() used to mean "loaded in this JS context", so every reload made the
    // reader fall back to the system voice while Settings still said Ready.
    await setModelReady('pocket', true);
    resetPocketEngine();
    await expect(pocketEngine.isReady()).resolves.toBe(true);
    await setModelReady('pocket', false);
    await expect(pocketEngine.isReady()).resolves.toBe(false);
  });
});