// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
      opts.onChunk?.(new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]));
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

  it('rejects synthesis that the library cut short', async () => {
    lib.stopped = true;
    await expect(pocketEngine.synthesize!('metformin', { rate: 1 })).rejects.toThrow('stopped');
  });
});
