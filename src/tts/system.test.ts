import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpeakEvents } from '../core/types';
import { __systemInternals, systemEngine } from './system';

// The native branch is a dynamic import; the mock must be hoisted above it.
const nativeMock = vi.hoisted(() => {
  type SpeakOpts = { text: string; lang?: string; rate?: number; voice?: number };
  const calls: SpeakOpts[] = [];
  // Each speak() stays pending until a test resolves it, like a real utterance.
  const pending: (() => void)[] = [];
  const state = { stops: 0 };
  const impl = {
    speak(opts: SpeakOpts): Promise<void> {
      calls.push(opts);
      return new Promise<void>((resolve) => {
        pending.push(resolve);
      });
    },
    async stop(): Promise<void> {
      // Android clears its request map without resolving the pending speak().
      state.stops += 1;
    },
    async getSupportedVoices() {
      return {
        voices: [
          { name: 'Samantha', lang: 'en-US', voiceURI: 'com.apple.samantha' },
          { name: 'Anna', lang: 'de-DE', voiceURI: 'de.anna' },
        ],
      };
    },
  };
  const resolveAll = () => {
    for (const resolve of pending.splice(0)) resolve();
  };
  return {
    calls,
    impl,
    state,
    resolveAll,
    reset(): void {
      calls.length = 0;
      pending.length = 0;
      state.stops = 0;
    },
  };
});

vi.mock('@capacitor-community/text-to-speech', () => ({ TextToSpeech: nativeMock.impl }));

// ---------------------------------------------------------------------------
// Web Speech doubles
// ---------------------------------------------------------------------------

class FakeUtterance {
  text: string;
  lang = '';
  rate = 1;
  voice: unknown = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onboundary: ((e: { name: string; charIndex: number }) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

class FakeSynth {
  queue: FakeUtterance[] = [];
  cancels = 0;
  pauseCalls = 0;
  resumeCalls = 0;
  paused = false;
  speaking = false;
  pending = false;
  voices: { name: string; lang: string; voiceURI: string; default: boolean }[] = [
    { name: 'Samantha', lang: 'en-US', voiceURI: 'com.apple.samantha', default: true },
    { name: 'Anna', lang: 'de-DE', voiceURI: 'de.anna', default: false },
  ];
  private listeners = new Map<string, Set<() => void>>();

  speak(u: FakeUtterance): void {
    this.queue.push(u);
  }
  cancel(): void {
    this.cancels += 1;
  }
  pause(): void {
    this.pauseCalls += 1;
    this.paused = true;
  }
  resume(): void {
    this.resumeCalls += 1;
    this.paused = false;
  }
  getVoices() {
    return this.voices;
  }
  addEventListener(type: string, fn: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  emit(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
}

let synth: FakeSynth;

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function events() {
  const log: string[] = [];
  const words: [string, number][] = [];
  const errors: Error[] = [];
  const ev: SpeakEvents = {
    onStart: (id) => log.push(`start:${id}`),
    onEnd: (id) => log.push(`end:${id}`),
    onWord: (id, i) => words.push([id, i]),
    onError: (e) => errors.push(e),
  };
  return { ev, log, words, errors };
}

beforeEach(() => {
  synth = new FakeSynth();
  __systemInternals.resetVoices();
  vi.stubGlobal('speechSynthesis', synth);
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
});

afterEach(() => {
  systemEngine.stop();
  vi.unstubAllGlobals();
  nativeMock.reset();
});

// ---------------------------------------------------------------------------

describe('chunks', () => {
  it('splits after sentence punctuation', () => {
    expect(__systemInternals.chunks('One. Two! Three?')).toEqual(['One.', 'Two!', 'Three?']);
  });

  it('keeps every piece under the Chrome 15-second limit', () => {
    const long = 'word, '.repeat(200);
    const parts = __systemInternals.chunks(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(300);
  });

  it('drops empty pieces', () => {
    expect(__systemInternals.chunks('   ')).toEqual([]);
  });
});

describe('systemEngine (web)', () => {
  it('is the web engine outside a Capacitor shell', () => {
    expect(__systemInternals.isNative()).toBe(false);
    expect(systemEngine).toBe(__systemInternals.webEngine);
    expect(systemEngine.capabilities).toMatchObject({ streaming: true, prerender: false, needsDownload: false });
  });

  it('speaks one utterance per sentence with start/end by id', async () => {
    const { ev, log } = events();
    const done = systemEngine.speak(
      [
        { id: 's1', text: 'Alpha beta.' },
        { id: 's2', text: 'Gamma delta.' },
      ],
      { rate: 1 },
      ev,
    );

    await until(() => synth.queue.length === 1);
    expect(synth.queue[0]?.text).toBe('Alpha beta.');
    synth.queue[0]!.onstart?.();
    synth.queue[0]!.onend?.();
    await until(() => synth.queue.length === 2);
    expect(synth.queue[1]?.text).toBe('Gamma delta.');
    synth.queue[1]!.onstart?.();
    synth.queue[1]!.onend?.();
    await done;

    expect(log).toEqual(['start:s1', 'end:s1', 'start:s2', 'end:s2']);
  });

  it('reports word boundaries with a char index inside the sentence', async () => {
    const { ev, words } = events();
    const done = systemEngine.speak([{ id: 's1', text: 'Alpha beta gamma.' }], { rate: 1 }, ev);

    await until(() => synth.queue.length === 1);
    synth.queue[0]!.onstart?.();
    synth.queue[0]!.onboundary?.({ name: 'word', charIndex: 6 });
    synth.queue[0]!.onboundary?.({ name: 'sentence', charIndex: 0 });
    synth.queue[0]!.onend?.();
    await done;

    expect(words).toEqual([['s1', 6]]);
  });

  it('passes the chosen voice and clamps the rate', async () => {
    const { ev } = events();
    const done = systemEngine.speak([{ id: 's1', text: 'Hi.' }], { rate: 99, voiceId: 'com.apple.samantha' }, ev);
    await until(() => synth.queue.length === 1);
    expect(synth.queue[0]?.rate).toBe(10);
    expect((synth.queue[0]?.voice as { voiceURI?: string } | null)?.voiceURI).toBe('com.apple.samantha');
    synth.queue[0]!.onend?.();
    await done;
  });

  it('stops on request without ending the remaining sentences', async () => {
    const { ev, log } = events();
    const done = systemEngine.speak(
      [
        { id: 's1', text: 'Alpha.' },
        { id: 's2', text: 'Beta.' },
      ],
      { rate: 1 },
      ev,
    );
    await until(() => synth.queue.length === 1);
    systemEngine.stop();
    synth.queue[0]!.onend?.();
    await done;

    expect(synth.cancels).toBeGreaterThan(1);
    expect(log).toEqual([]);
  });

  it('pauses by cancelling, keeps the call pending, and replays the chunk on resume', async () => {
    const { ev, log } = events();
    const done = systemEngine.speak([{ id: 's1', text: 'Alpha beta.' }], { rate: 1 }, ev);

    await until(() => synth.queue.length === 1);
    synth.queue[0]!.onstart?.();
    systemEngine.pause();
    // Chrome Android's pause() is unreliable; we must never touch it.
    expect(synth.pauseCalls).toBe(0);
    expect(synth.cancels).toBeGreaterThan(0);

    // Chrome reports our cancel as an error; the sentence promise must remain
    // pending so the player does not run ahead while paused.
    const settled: string[] = [];
    void done.then(() => settled.push('done'));
    synth.queue[0]!.onerror?.({ error: 'canceled' });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toEqual([]);
    expect(log).toEqual(['start:s1']);

    systemEngine.resume();
    await until(() => synth.queue.length === 2);
    expect(synth.queue[1]?.text).toBe('Alpha beta.');
    synth.queue[1]!.onend?.();
    await done;

    expect(settled).toEqual(['done']);
    expect(log).toEqual(['start:s1', 'end:s1']);
  });

  it('resumes an engine another page left paused', async () => {
    synth.paused = true;
    const { ev } = events();
    const done = systemEngine.speak([{ id: 's1', text: 'Alpha.' }], { rate: 1 }, ev);
    await until(() => synth.queue.length === 1);
    expect(synth.resumeCalls).toBeGreaterThan(0);
    synth.queue[0]!.onend?.();
    await done;
  });

  it('ignores a cancel error but reports a real one', async () => {
    const first = events();
    const doneA = systemEngine.speak([{ id: 's1', text: 'Alpha.' }], { rate: 1 }, first.ev);
    await until(() => synth.queue.length === 1);
    synth.queue[0]!.onerror?.({ error: 'canceled' });
    await doneA;
    expect(first.errors).toHaveLength(0);

    const second = events();
    const doneB = systemEngine.speak([{ id: 's2', text: 'Beta.' }], { rate: 1 }, second.ev);
    await until(() => synth.queue.length === 2);
    synth.queue[1]!.onerror?.({ error: 'network' });
    await doneB;
    expect(second.errors[0]?.message).toContain('network');
  });

  it('lists English voices only, using the voiceURI as id', async () => {
    const voices = await systemEngine.listVoices();
    expect(voices).toEqual([{ id: 'com.apple.samantha', name: 'Samantha', lang: 'en-US' }]);
  });

  it('waits briefly for voiceschanged when getVoices() starts empty', async () => {
    synth.voices = [];
    const pending = systemEngine.listVoices();
    setTimeout(() => {
      synth.voices = [{ name: 'Daniel', lang: 'en-GB', voiceURI: 'daniel', default: false }];
      synth.emit('voiceschanged');
    }, 20);
    const voices = await pending;
    expect(voices).toEqual([{ id: 'daniel', name: 'Daniel', lang: 'en-GB' }]);
  });

  it('reports an absent speech engine instead of hanging', async () => {
    vi.stubGlobal('speechSynthesis', undefined);
    const { ev, errors } = events();
    await systemEngine.speak([{ id: 's1', text: 'Alpha.' }], { rate: 1 }, ev);
    expect(errors[0]?.message).toContain('no speech synthesis');
  });
});

describe('systemEngine (native)', () => {
  beforeEach(() => {
    nativeMock.reset();
    __systemInternals.resetVoices();
  });

  it('reports no word boundaries', () => {
    expect(__systemInternals.nativeEngine.capabilities.wordBoundaries).toBe(false);
  });

  it('speaks sentences sequentially through the plugin', async () => {
    const { ev, log } = events();
    const done = __systemInternals.nativeEngine.speak(
      [
        { id: 's1', text: 'Alpha.' },
        { id: 's2', text: 'Beta.' },
      ],
      { rate: 1.2 },
      ev,
    );

    await until(() => nativeMock.calls.length === 1);
    nativeMock.resolveAll();
    await until(() => nativeMock.calls.length === 2);
    expect(nativeMock.calls[0]).toMatchObject({ text: 'Alpha.', lang: 'en-US', rate: 1.2 });
    nativeMock.resolveAll();
    await done;

    expect(log).toEqual(['start:s1', 'end:s1', 'start:s2', 'end:s2']);
  });

  it('maps a voice id to the plugin voice index', async () => {
    const done = __systemInternals.nativeEngine.speak([{ id: 's1', text: 'Hi.' }], { rate: 1, voiceId: 'de.anna' }, {});
    await until(() => nativeMock.calls.length === 1);
    expect(nativeMock.calls[0]?.voice).toBe(1);
    __systemInternals.nativeEngine.stop();
    await done;
  });

  it('clamps the rate to the Android 0.1–2.0 range', async () => {
    const done = __systemInternals.nativeEngine.speak([{ id: 's1', text: 'Hi.' }], { rate: 99 }, {});
    await until(() => nativeMock.calls.length === 1);
    expect(nativeMock.calls[0]?.rate).toBe(2);
    __systemInternals.nativeEngine.stop();
    await done;

    const doneSlow = __systemInternals.nativeEngine.speak([{ id: 's2', text: 'Hi.' }], { rate: 0.01 }, {});
    await until(() => nativeMock.calls.length === 2);
    expect(nativeMock.calls[1]?.rate).toBe(0.1);
    __systemInternals.nativeEngine.stop();
    await doneSlow;
  });

  it('pauses by stopping the plugin and re-speaks the sentence on resume', async () => {
    const { ev, log } = events();
    const done = __systemInternals.nativeEngine.speak([{ id: 's1', text: 'Alpha.' }], { rate: 1 }, ev);

    await until(() => nativeMock.calls.length === 1);
    const settled: string[] = [];
    void done.then(() => settled.push('done'));

    __systemInternals.nativeEngine.pause();
    expect(nativeMock.state.stops).toBe(1);
    // The plugin call never resolves on Android after stop; ours must not hang.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toEqual([]);
    expect(log).toEqual(['start:s1']);

    __systemInternals.nativeEngine.resume();
    await until(() => nativeMock.calls.length === 2);
    expect(nativeMock.calls[1]?.text).toBe('Alpha.');
    nativeMock.resolveAll();
    await done;

    expect(log).toEqual(['start:s1', 'end:s1']);
  });

  it('settles a hung plugin call when stopped', async () => {
    const done = __systemInternals.nativeEngine.speak([{ id: 's1', text: 'Alpha.' }], { rate: 1 }, {});
    await until(() => nativeMock.calls.length === 1);
    __systemInternals.nativeEngine.stop();
    // Android's stop() never resolves speak(); await would hang without our flush.
    const outcome = await Promise.race([
      done.then(() => 'settled'),
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 1000)),
    ]);
    expect(outcome).toBe('settled');
    expect(nativeMock.state.stops).toBeGreaterThan(0);
  });

  it('lists English voices only', async () => {
    const voices = await __systemInternals.nativeEngine.listVoices();
    expect(voices).toEqual([{ id: 'com.apple.samantha', name: 'Samantha', lang: 'en-US' }]);
  });
});
