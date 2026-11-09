import { afterEach, describe, expect, it, vi } from 'vitest';
import { FloatPlayer } from './playback';

interface FakeSource {
  buffer: { getChannelData: (channel: number) => Float32Array } | null;
  playbackRate: { value: number };
  onended: (() => void) | null;
  connect: (dest: unknown) => void;
  disconnect: () => void;
  start: () => void;
  stop: () => void;
  started: boolean;
  stopped: number;
}

function installAudioContext(opts: { suspended?: boolean; resumeGate?: Promise<void> } = {}): {
  ctx: Record<string, unknown>;
  lastSource: () => FakeSource;
} {
  let last: FakeSource | null = null;
  const ctx = {
    state: (opts.suspended ? 'suspended' : 'running') as AudioContextState,
    destination: {},
    resume: vi.fn(() => opts.resumeGate ?? Promise.resolve()),
    suspend: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    createBuffer: vi.fn((channels: number, length: number, sampleRate: number) => ({
      numberOfChannels: channels,
      length,
      sampleRate,
      getChannelData: () => new Float32Array(length),
    })),
    createBufferSource: vi.fn(() => {
      const source: FakeSource = {
        buffer: null,
        playbackRate: { value: 1 },
        onended: null,
        connect: () => {},
        disconnect: () => {},
        start: () => {
          source.started = true;
        },
        stop: () => {
          source.stopped += 1;
          source.onended?.();
        },
        started: false,
        stopped: 0,
      };
      last = source;
      return source;
    }),
  };
  vi.stubGlobal(
    'AudioContext',
    class {
      constructor() {
        return ctx;
      }
    }
  );
  return { ctx, lastSource: () => last as FakeSource };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FloatPlayer', () => {
  it('plays PCM at the requested rate and resolves on end', async () => {
    const { ctx, lastSource } = installAudioContext();
    const player = new FloatPlayer();
    let finished = false;

    const done = player.play(new Float32Array([0.25, -0.25]), 24000, 1.5).then(() => {
      finished = true;
    });

    const source = lastSource();
    expect(ctx.createBuffer).toHaveBeenCalledWith(1, 2, 24000);
    expect(source.playbackRate.value).toBe(1.5);
    expect(source.started).toBe(true);

    source.onended?.();
    await done;
    expect(finished).toBe(true);
  });

  it('resolves and silences the source when stopped mid-utterance', async () => {
    const { lastSource } = installAudioContext();
    const player = new FloatPlayer();
    const done = player.play(new Float32Array(16), 24000);

    player.stop();

    expect(lastSource().stopped).toBe(1);
    await expect(done).resolves.toBeUndefined();
  });

  it('does not start audio when stopped while the context is resuming', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { ctx } = installAudioContext({ suspended: true, resumeGate: gate });
    const player = new FloatPlayer();

    const done = player.play(new Float32Array(8), 24000);
    await Promise.resolve(); // play() is now parked on ctx.resume()
    player.stop();
    release();
    await done;

    expect(ctx.createBufferSource).not.toHaveBeenCalled();
  });

  it('waits while paused instead of starting the next clip', async () => {
    const { ctx, lastSource } = installAudioContext();
    const player = new FloatPlayer();
    player.pause();

    const done = player.play(new Float32Array(8), 24000);
    await Promise.resolve();
    expect(ctx.createBufferSource).not.toHaveBeenCalled();
    expect(ctx.resume).not.toHaveBeenCalled(); // an explicit pause is not undone by play()

    player.resume();
    await Promise.resolve();
    expect(lastSource().started).toBe(true);
    player.stop();
    await done;
  });

  it('ignores empty audio', async () => {
    installAudioContext();
    const player = new FloatPlayer();
    await expect(player.play(new Float32Array(0), 24000)).resolves.toBeUndefined();
  });

  it('closes the AudioContext on dispose', async () => {
    const { ctx } = installAudioContext();
    const player = new FloatPlayer();
    const done = player.play(new Float32Array(8), 24000);
    player.stop();
    await done;

    await player.dispose();
    expect(ctx.close).toHaveBeenCalled();
  });
});
