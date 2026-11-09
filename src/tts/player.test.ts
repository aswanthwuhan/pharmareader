import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../core/db';
import type { SpeakEvents, TtsCapabilities, TtsEngine } from '../core/types';
import { invalidate } from './lexicon';
import { createPlayer } from './player';

// ---------------------------------------------------------------------------
// Test doubles: jsdom has neither object URLs nor a working audio element.
// ---------------------------------------------------------------------------

class FakeAudio {
  static instances: FakeAudio[] = [];
  src: string;
  paused = true;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }
  play(): Promise<void> {
    this.paused = false;
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

async function until(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  FakeAudio.instances = [];
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
    await new Promise((resolve) => setTimeout(resolve, 20));
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
    await new Promise((resolve) => setTimeout(resolve, 30));

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
  it('renders, caches and plays sentences through audio elements', async () => {
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
    await until(() => FakeAudio.instances.length === 1);
    const first = FakeAudio.instances[0]!;
    // Prefetching may already have created other URLs, so match the set.
    expect(created).toContain(first.src);
    first.finish();

    await until(() => FakeAudio.instances.length === 2);
    FakeAudio.instances[1]!.finish();
    await until(() => FakeAudio.instances.length === 3);
    FakeAudio.instances[2]!.finish();
    await until(() => done === 1);

    expect(seen).toEqual(['s1', 's2', 's3']);
    expect(engine.synthTexts).toHaveLength(3);
    expect(await db.audioCache.count()).toBe(3);
  });

  it('reuses cached audio for a second session without re-synthesising', async () => {
    const engine = new FakeEngine(true);
    const first = createPlayer({ ...baseOptions, items: [items[0]!], engine });
    first.play();
    await until(() => FakeAudio.instances.length === 1);
    FakeAudio.instances[0]!.finish();
    await until(() => engine.synthTexts.length === 1);

    const second = createPlayer({ ...baseOptions, items: [items[0]!], engine });
    second.play();
    await until(() => FakeAudio.instances.length === 2);
    expect(engine.synthTexts).toHaveLength(1);
    second.stop();
  });

  it('pauses and resumes the audio element', async () => {
    const engine = new FakeEngine(true);
    const player = createPlayer({ ...baseOptions, items: [items[0]!], engine });

    player.play();
    await until(() => FakeAudio.instances.length === 1);
    const el = FakeAudio.instances[0]!;
    await until(() => el.paused === false);

    player.pause();
    expect(el.paused).toBe(true);
    player.resume();
    expect(el.paused).toBe(false);
    player.stop();
  });

  it('revokes object URLs when the cache evicts them', async () => {
    const engine = new FakeEngine(true);
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, text: `Sentence ${i}.` }));
    const player = createPlayer({ ...baseOptions, items: many, engine });

    player.play();
    for (let i = 0; i < many.length; i++) {
      await until(() => FakeAudio.instances.length === i + 1);
      FakeAudio.instances[i]!.finish();
    }
    await until(() => revoked.length > 0);
    // 8 rendered, 6 kept.
    expect(revoked.length).toBe(2);
    player.stop();
  });

  it('reports a synthesis failure without playing anything', async () => {
    const engine = new FakeEngine(true);
    engine.synthError = new Error('model not loaded');
    const errors: Error[] = [];
    const player = createPlayer({ ...baseOptions, items: [items[0]!], engine, onError: (e) => errors.push(e) });

    player.play();
    await until(() => errors.length === 1);
    expect(errors[0]?.message).toBe('model not loaded');
    expect(FakeAudio.instances).toHaveLength(0);
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
    await until(() => FakeAudio.instances.length === 1);
    FakeAudio.instances[0]!.fail();
    await until(() => errors.length === 1);
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
