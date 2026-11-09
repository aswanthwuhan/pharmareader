import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../core/db';
import type { SpeakEvents, TtsCapabilities, TtsEngine } from '../core/types';
import { invalidate } from './lexicon';
import { createPlayer } from './player';

// ---------------------------------------------------------------------------
// Test doubles: jsdom has neither object URLs nor a working audio element.
// ---------------------------------------------------------------------------

/** A RIFF/WAVE clip: 8 kHz, 8-bit mono, `dataSize` bytes of silence. */
function wavBlob(byteRate: number, dataSize: number): Blob {
  const buf = new Uint8Array(44 + dataSize);
  const view = new DataView(buf.buffer);
  const tag = (offset: number, text: string) => {
    for (let i = 0; i < 4; i++) buf[offset + i] = text.charCodeAt(i);
  };
  tag(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  tag(36, 'data');
  view.setUint32(40, dataSize, true);
  return new Blob([buf]);
}

class FakeAudio {
  static instances: FakeAudio[] = [];
  /** How many upcoming play() calls hang until gateNow() (autoplay-settle tests). */
  static holdPlays = 0;

  src = '';
  muted = false;
  paused = true;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private gate: (() => void) | null = null;

  constructor(src = '') {
    this.src = src;
    FakeAudio.instances.push(this);
  }
  play(): Promise<void> {
    this.paused = false;
    if (FakeAudio.holdPlays > 0) {
      FakeAudio.holdPlays--;
      return new Promise<void>((resolve) => {
        this.gate = resolve;
      });
    }
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
  finish(): void {
    this.paused = true;
    this.onended?.();
  }
  fail(): void {
    this.onerror?.();
  }
  gateNow(): void {
    this.gate?.();
    this.gate = null;
  }
}

let urlSeq = 0;
const created: string[] = [];
const revoked: string[] = [];

interface Spoken {
  id: string;
  text: string;
  rate: number;
  voiceId?: string;
}

class FakeEngine implements TtsEngine {
  id = 'system' as const;
  label = 'Fake';
  capabilities: TtsCapabilities = {
    streaming: true,
    prerender: false,
    wordBoundaries: true,
    needsDownload: false,
  };
  spoken: Spoken[] = [];
  synthTexts: string[] = [];
  stopped = 0;
  paused = 0;
  resumed = 0;
  failNext = false;
  synthError: Error | null = null;

  private pending: (() => void)[] = [];

  /** Present only for engines that can render audio. */
  synthesize?: (text: string, opts: { voiceId?: string; rate: number }) => Promise<Blob>;

  constructor(canSynth: boolean) {
    if (canSynth) {
      this.synthesize = async (text: string) => {
        this.synthTexts.push(text);
        if (this.synthError) throw this.synthError;
        return new Blob([new Uint8Array(4)]);
      };
    }
  }

  async isReady(): Promise<boolean> {
    return true;
  }
  async prepare(): Promise<void> {}
  async listVoices() {
    return [{ id: 'v1', name: 'Voice', lang: 'en-US' }];
  }

  async speak(items: { id: string; text: string }[], opts: { voiceId?: string; rate: number }, ev: SpeakEvents): Promise<void> {
    const item = items[0]!;
    this.spoken.push({ id: item.id, text: item.text, rate: opts.rate, voiceId: opts.voiceId });
    ev.onStart?.(item.id);
    await new Promise<void>((resolve) => this.pending.push(resolve));
    if (this.failNext) {
      ev.onError?.(new Error('engine exploded'));
      return;
    }
    ev.onEnd?.(item.id);
  }

  stop(): void {
    this.stopped++;
  }
  pause(): void {
    this.paused++;
  }
  resume(): void {
    this.resumed++;
  }

  /** Let the utterance currently being spoken finish. */
  releaseAll(): void {
    const waiting = this.pending;
    this.pending = [];
    for (const resolve of waiting) resolve();
  }
}

const items = [
  { id: 's1', text: 'Alpha.' },
  { id: 's2', text: 'Beta.' },
  { id: 's3', text: 'Gamma.' },
];

const baseOptions = {
  items,
  startIndex: 0,
  rate: 1,
  onSentence: () => {},
  onDone: () => {},
  onError: () => {},
};

async function until(check: () => boolean, timeoutMs = 1500): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  FakeAudio.instances = [];
  FakeAudio.holdPlays = 0;
  urlSeq = 0;
  created.length = 0;
  revoked.length = 0;
  vi.stubGlobal('Audio', FakeAudio);
  // jsdom ships neither of these.
  URL.createObjectURL = ((blob: Blob) => {
    const url = `blob:fake-${++urlSeq}`;
    created.push(url);
    void blob;
    return url;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => {
    revoked.push(url);
  }) as typeof URL.revokeObjectURL;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete (URL as { createObjectURL?: unknown }).createObjectURL;
  delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
  await db.delete();
  await db.open();
  invalidate();
});

// ---------------------------------------------------------------------------

describe('streaming engines', () => {
  it('speaks each sentence in order and finishes once', async () => {
    const engine = new FakeEngine(false);
    const seen: string[] = [];
    let done = 0;
    const player = createPlayer({
      ...baseOptions,
      engine,
      onSentence: (id) => seen.push(id),
      onDone: () => (done += 1),
    });

    player.play();
    // No audio element is created: streaming engines have no clip to unlock.
    expect(FakeAudio.instances).toHaveLength(0);
    await until(() => engine.spoken.length === 1);
    engine.releaseAll();
    await until(() => engine.spoken.length === 2);
    engine.releaseAll();
    await until(() => engine.spoken.length === 3);
    engine.releaseAll();
    await until(() => done === 1);

    expect(engine.spoken.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(seen).toEqual(['s1', 's2', 's3']);
    expect(done).toBe(1);
  });

  it('does not start a second queue when play() is called twice', async () => {
    const engine = new FakeEngine(false);
    const player = createPlayer({ ...baseOptions, engine });

    player.play();
    player.play();
    await until(() => engine.spoken.length === 1);
    await delay(20);
    expect(engine.spoken).toHaveLength(1);
  });

  it('stops mid-sentence without firing onDone', async () => {
    const engine = new FakeEngine(false);
    const seen: string[] = [];
    let done = 0;
    const player = createPlayer({
      ...baseOptions,
      engine,
      onSentence: (id) => seen.push(id),
      onDone: () => (done += 1),
    });

    player.play();
    await until(() => engine.spoken.length === 1);
    player.stop();
    engine.releaseAll();
    await delay(30);

    expect(engine.stopped).toBeGreaterThan(0);
    expect(seen).toEqual(['s1']);
    expect(done).toBe(0);
  });

  it('seeks to another sentence', async () => {
    const engine = new FakeEngine(false);
    const player = createPlayer({ ...baseOptions, engine });

    player.play();
    await until(() => engine.spoken.length === 1);
    player.seek(2);
    await until(() => engine.spoken.length === 2);
    expect(engine.spoken[1]?.id).toBe('s3');
    player.stop();
  });

  it('survives a burst of seeks: only the last run speaks', async () => {
    const engine = new FakeEngine(false);
    const player = createPlayer({ ...baseOptions, engine });

    player.play();
    player.seek(1);
    player.seek(2);
    player.seek(0);
    await until(() => engine.spoken.length >= 1);
    await delay(40);
    expect(engine.spoken).toHaveLength(1);
    expect(engine.spoken[0]?.id).toBe('s1');
    player.stop();
  });

  it('pauses and resumes the engine', async () => {
    const engine = new FakeEngine(false);
    const player = createPlayer({ ...baseOptions, engine });

    player.play();
    await until(() => engine.spoken.length === 1);
    player.pause();
    expect(engine.paused).toBe(1);
    player.resume();
    expect(engine.resumed).toBe(1);
    player.stop();
  });

  it('reports an engine error once and stops', async () => {
    const engine = new FakeEngine(false);
    engine.failNext = true;
    const errors: Error[] = [];
    let done = 0;
    const player = createPlayer({
      ...baseOptions,
      engine,
      onError: (e) => errors.push(e),
      onDone: () => (done += 1),
    });

    player.play();
    await until(() => engine.spoken.length === 1);
    engine.releaseAll();
    await until(() => errors.length === 1);

    expect(errors[0]?.message).toBe('engine exploded');
    expect(done).toBe(0);
    expect(engine.spoken).toHaveLength(1);
  });

  it('expands text through the lexicon before speaking', async () => {
    const engine = new FakeEngine(false);
    const player = createPlayer({
      ...baseOptions,
      engine,
      items: [{ id: 'x', text: 'Digoxin 5 mg b.d.' }],
    });

    player.play();
    await until(() => engine.spoken.length === 1);
    expect(engine.spoken[0]?.text).toBe('Digoxin 5 milligrams twice daily');
    player.stop();
  });
});

describe('synthesising engines', () => {
  it('renders, caches and plays sentences through one reused audio element', async () => {
    const engine = new FakeEngine(true);
    const seen: string[] = [];
    let done = 0;
    const player = createPlayer({
      ...baseOptions,
      engine,
      onSentence: (id) => seen.push(id),
      onDone: () => (done += 1),
    });

    player.play();
    const el = FakeAudio.instances[0]!;
    expect(el.src.startsWith('data:audio/wav')).toBe(true); // gesture unlock
    expect(el.muted).toBe(true);

    const playedSrcs: string[] = [];
    for (let i = 0; i < items.length; i++) {
      await until(() => el.src.startsWith('blob:') && !playedSrcs.includes(el.src));
      playedSrcs.push(el.src);
      expect(el.muted).toBe(false);
      el.finish();
    }
    await until(() => done === 1);

    expect(FakeAudio.instances).toHaveLength(1); // one element for the whole book
    expect(playedSrcs).toHaveLength(3);
    expect(seen).toEqual(['s1', 's2', 's3']);
    expect(engine.synthTexts).toHaveLength(3);
    expect(await db.audioCache.count()).toBe(3);
  });

  it('stores a real durationMs when the clip is a WAV', async () => {
    const engine = new FakeEngine(true);
    engine.synthesize = async () => wavBlob(8000, 16000); // 2 s
    let done = 0;
    const player = createPlayer({ ...baseOptions, items: [items[0]!], engine, onDone: () => (done += 1) });

    player.play();
    const el = FakeAudio.instances[0]!;
    await until(() => el.src.startsWith('blob:'));
    await delay(10);

    const rows = await db.audioCache.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.durationMs).toBe(2000);

    el.finish();
    await until(() => done === 1);
  });

  it('reuses cached audio for a second session without re-synthesising', async () => {
    const engine = new FakeEngine(true);
    const first = createPlayer({ ...baseOptions, items: [items[0]!], engine });
    first.play();
    const firstEl = FakeAudio.instances[0]!;
    await until(() => firstEl.src.startsWith('blob:'));
    firstEl.finish();
    await until(() => engine.synthTexts.length === 1);

    const second = createPlayer({ ...baseOptions, items: [items[0]!], engine });
    second.play();
    expect(FakeAudio.instances).toHaveLength(2);
    const secondEl = FakeAudio.instances[1]!;
    await until(() => secondEl.src.startsWith('blob:'));
    expect(engine.synthTexts).toHaveLength(1);
    second.stop();
  });

  it('pauses and resumes the audio element', async () => {
    const engine = new FakeEngine(true);
    const player = createPlayer({ ...baseOptions, items: [items[0]!], engine });

    player.play();
    const el = FakeAudio.instances[0]!;
    await until(() => el.src.startsWith('blob:'));
    await until(() => el.paused === false);

    player.pause();
    expect(el.paused).toBe(true);
    player.resume();
    expect(el.paused).toBe(false);
    player.stop();
  });

  it('does not play before resume() when paused during synthesis', async () => {
    const engine = new FakeEngine(true);
    const gate: { release?: (blob: Blob) => void } = {};
    engine.synthesize = () =>
      new Promise<Blob>((resolve) => {
        gate.release = resolve;
      });
    const player = createPlayer({ ...baseOptions, items: [items[0]!], engine });

    player.play();
    const el = FakeAudio.instances[0]!;
    await until(() => gate.release !== undefined);
    player.pause();
    gate.release!(wavBlob(8000, 16000));
    await delay(30);
    expect(el.src.startsWith('blob:')).toBe(false);

    player.resume();
    await until(() => el.src.startsWith('blob:'));
    await until(() => el.paused === false);
    player.stop();
  });

  it('revokes object URLs when the cache evicts them, never the one loaded', async () => {
    const engine = new FakeEngine(true);
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, text: `Sentence ${i}.` }));
    let done = 0;
    const player = createPlayer({ ...baseOptions, items: many, engine, onDone: () => (done += 1) });

    player.play();
    const el = FakeAudio.instances[0]!;
    const playedSrcs: string[] = [];
    for (let i = 0; i < many.length; i++) {
      await until(() => el.src.startsWith('blob:') && !playedSrcs.includes(el.src));
      playedSrcs.push(el.src);
      expect(revoked).not.toContain(el.src);
      el.finish();
    }
    await until(() => done === 1);
    // 8 rendered, 6 kept.
    expect(revoked).toHaveLength(2);
    player.stop();
  });

  it('reports a synthesis failure without loading a clip', async () => {
    const engine = new FakeEngine(true);
    engine.synthError = new Error('model not loaded');
    const errors: Error[] = [];
    const player = createPlayer({ ...baseOptions, items: [items[0]!], engine, onError: (e) => errors.push(e) });

    player.play();
    await until(() => errors.length === 1);
    expect(errors[0]?.message).toBe('model not loaded');
    // The silent gesture-unlock clip was primed, but no real audio was loaded.
    expect(FakeAudio.instances.every((a) => !a.src.startsWith('blob:'))).toBe(true);
  });

  it('recovers when a prefetch fails but the sentence itself can be rendered', async () => {
    const engine = new FakeEngine(true);
    const calls: string[] = [];
    let betaFailures = 1;
    engine.synthesize = async (text: string) => {
      calls.push(text);
      await delay(5); // let the prefetch of the next sentence start first
      if (text.includes('Beta') && betaFailures > 0) {
        betaFailures--;
        throw new Error('transient');
      }
      return wavBlob(8000, 160);
    };
    const errors: Error[] = [];
    let done = 0;
    const player = createPlayer({
      ...baseOptions,
      engine,
      onError: (e) => errors.push(e),
      onDone: () => (done += 1),
    });

    player.play();
    const el = FakeAudio.instances[0]!;
    const played: string[] = [];
    for (let i = 0; i < items.length; i++) {
      await until(() => el.src.startsWith('blob:') && !played.includes(el.src));
      played.push(el.src);
      el.finish();
    }
    await until(() => done === 1);
    expect(errors).toHaveLength(0);
    // Beta was attempted twice: once by the failed prefetch, once for playback.
    expect(calls.filter((t) => t.includes('Beta'))).toHaveLength(2);
    expect(played).toHaveLength(3);
  });

  it('reports an audio element failure and stops', async () => {
    const engine = new FakeEngine(true);
    const errors: Error[] = [];
    let done = 0;
    const player = createPlayer({
      ...baseOptions,
      items: [items[0]!],
      engine,
      onError: (e) => errors.push(e),
      onDone: () => (done += 1),
    });

    player.play();
    const el = FakeAudio.instances[0]!;
    await until(() => el.src.startsWith('blob:'));
    el.fail();
    await until(() => errors.length === 1);
    expect(errors[0]?.message).toBe('Audio playback failed.');
    expect(done).toBe(0);
  });

  it('settles a stop() that lands while play() is still pending', async () => {
    const engine = new FakeEngine(true);
    FakeAudio.holdPlays = 2; // the gesture primer and the first real clip
    const errors: Error[] = [];
    let done = 0;
    const player = createPlayer({
      ...baseOptions,
      items: [items[0]!],
      engine,
      onError: (e) => errors.push(e),
      onDone: () => (done += 1),
    });

    player.play();
    const el = FakeAudio.instances[0]!;
    await until(() => el.src.startsWith('blob:'));
    const beforeStop = el.src;
    player.stop();
    await delay(30);
    expect(errors).toHaveLength(0);
    expect(done).toBe(0);
    expect(revoked.length).toBeGreaterThan(0);

    // The player is not wedged: a fresh play() still works and completes.
    player.play();
    await until(() => el.src.startsWith('blob:') && el.src !== beforeStop);
    el.finish();
    await until(() => done === 1);
  });

  it('revokes every object URL on stop()', async () => {
    const engine = new FakeEngine(true);
    let done = 0;
    const player = createPlayer({ ...baseOptions, items: [items[0]!], engine, onDone: () => (done += 1) });
    player.play();
    const el = FakeAudio.instances[0]!;
    await until(() => el.src.startsWith('blob:'));
    player.stop();
    expect(created.length).toBeGreaterThan(0);
    expect([...revoked].sort()).toEqual([...created].sort());
    expect(done).toBe(0);
  });

  it('prefetches upcoming sentences', async () => {
    const engine = new FakeEngine(true);
    const player = createPlayer({ ...baseOptions, engine });

    player.play();
    // Sentence 1 plus two prefetched renders, before any audio finished.
    await until(() => engine.synthTexts.length === 3);
    expect(FakeAudio.instances.length).toBeLessThanOrEqual(1);
    player.stop();
  });
});

describe('edge cases', () => {
  it('completes immediately for an empty list', async () => {
    const engine = new FakeEngine(false);
    let done = 0;
    const player = createPlayer({ ...baseOptions, items: [], engine, onDone: () => (done += 1) });
    player.play();
    expect(done).toBe(1);
  });

  it('clamps an out-of-range start index', async () => {
    const engine = new FakeEngine(false);
    const player = createPlayer({ ...baseOptions, engine, startIndex: 99 });
    player.play();
    await until(() => engine.spoken.length === 1);
    expect(engine.spoken[0]?.id).toBe('s3');
    player.stop();
  });
});
