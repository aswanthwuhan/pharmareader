/**
 * Playback queue for one reading session.
 *
 * Two paths, chosen by the engine: engines that can render audio
 * (`synthesize`) get their clips cached by hash and played through an
 * HTMLAudioElement, which gives exact pause/resume/seek; streaming engines
 * (the system voices) are driven sentence by sentence through `speak`.
 *
 * All asynchronous work checks a generation counter, so a stop or seek during
 * a synth or a playback can never be resumed by the call it interrupted.
 */
import type { AudioCacheRecord, TtsEngine } from '../core/types';
import { cacheKey, getAudio, putAudio } from './cache';
import { expand, lexiconVersion } from './lexicon';

export interface PlayerItem {
  id: string;
  text: string;
}

export interface PlayerOptions {
  engine: TtsEngine;
  items: PlayerItem[];
  startIndex: number;
  voiceId?: string;
  rate: number;
  onSentence(id: string): void;
  onDone(): void;
  onError(e: Error): void;
}

export interface Player {
  play(): void;
  pause(): void;
  resume(): void;
  stop(): void;
  seek(index: number): void;
}

/** Object URLs kept warm for back-to-back sentences; revoked when evicted. */
const URL_LRU_SIZE = 6;
/** How many upcoming sentences to render while the current one plays. */
const PREFETCH_AHEAD = 2;

type State = 'idle' | 'playing' | 'paused';

/** Internal signal: a newer generation took over. Never surfaces to the user. */
class AbortPlayback extends Error {}

export function createPlayer(options: PlayerOptions): Player {
  const { engine, items, voiceId, rate } = options;
  const canSynthesize = typeof engine.synthesize === 'function';

  let state: State = 'idle';
  let index = clamp(options.startIndex);
  let generation = 0;
  let audio: HTMLAudioElement | null = null;

  /** cache key → object URL, in least-recently-used order. */
  const urls = new Map<string, string>();
  const inflight = new Map<string, Promise<string>>();

  function clamp(i: number): number {
    if (!Number.isFinite(i)) return 0;
    return Math.min(Math.max(0, Math.trunc(i)), Math.max(0, items.length - 1));
  }

  // -- object-URL cache ----------------------------------------------------

  function remember(key: string, blob: Blob): string {
    const existing = urls.get(key);
    if (existing) {
      touch(key, existing);
      return existing;
    }
    const url = URL.createObjectURL(blob);
    urls.set(key, url);
    while (urls.size > URL_LRU_SIZE) {
      const oldestKey = urls.keys().next().value;
      if (oldestKey === undefined) break;
      const stale = urls.get(oldestKey);
      urls.delete(oldestKey);
      if (stale) URL.revokeObjectURL(stale);
    }
    return url;
  }

  function touch(key: string, url: string): void {
    urls.delete(key);
    urls.set(key, url);
  }

  function releaseAll(): void {
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
    inflight.clear();
  }

  // -- audio path ----------------------------------------------------------

  async function audioUrlFor(item: PlayerItem, gen: number): Promise<string> {
    const text = (await expand(item.text)) || item.text;
    if (gen !== generation) throw new AbortPlayback();

    const version = await lexiconVersion();
    const key = await cacheKey(text, engine.id, voiceId, rate, version);

    const ready = urls.get(key);
    if (ready) {
      touch(key, ready);
      return ready;
    }

    // A prefetch may already be rendering this exact clip.
    const pending = inflight.get(key);
    if (pending) return pending;

    const job = (async () => {
      const cached = await getAudio(key);
      let blob: Blob;
      if (cached) {
        blob = cached.audio;
      } else {
        blob = await engine.synthesize!(text, { voiceId, rate });
        const rec: AudioCacheRecord = {
          key,
          engine: engine.id,
          audio: blob,
          durationMs: 0, // filled in when the element reports its metadata
          createdAt: Date.now(),
        };
        await putAudio(rec);
      }
      if (gen !== generation) throw new AbortPlayback();
      return remember(key, blob);
    })();

    inflight.set(key, job);
    try {
      return await job;
    } finally {
      inflight.delete(key);
    }
  }

  function prefetch(from: number, gen: number): void {
    if (!canSynthesize) return;
    const end = Math.min(from + PREFETCH_AHEAD, items.length);
    for (let i = from; i < end; i++) {
      const item = items[i];
      if (!item) continue;
      // Failures are retried when the sentence is actually reached.
      void audioUrlFor(item, gen).catch(() => {});
    }
  }

  async function playAudioItem(item: PlayerItem, gen: number): Promise<void> {
    const url = await audioUrlFor(item, gen);
    if (gen !== generation) throw new AbortPlayback();
    await waitWhilePaused(gen);
    if (gen !== generation) throw new AbortPlayback();

    const el = new Audio(url);
    audio = el;

    try {
      await new Promise<void>((resolve, reject) => {
        el.onended = () => resolve();
        el.onerror = () => reject(new Error('The audio clip could not be played.'));
        const started = el.play();
        if (started && typeof started.catch === 'function') {
          started.catch((err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));
        }
      });
    } finally {
      if (audio === el) audio = null;
      el.onended = null;
      el.onerror = null;
    }
  }

  // -- streaming path ------------------------------------------------------

  async function speakItem(item: PlayerItem, gen: number): Promise<void> {
    const text = (await expand(item.text)) || item.text;
    if (gen !== generation) throw new AbortPlayback();
    await waitWhilePaused(gen);
    if (gen !== generation) throw new AbortPlayback();

    let failure: Error | undefined;
    await engine.speak([{ id: item.id, text }], { voiceId, rate }, {
      onError: (err) => {
        failure = err instanceof Error ? err : new Error(String(err));
      },
    });
    if (failure) throw failure;
  }

  /** Pause can land while a clip is still rendering; hold the queue there. */
  async function waitWhilePaused(gen: number): Promise<void> {
    while (state === 'paused' && gen === generation) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }

  // -- queue ---------------------------------------------------------------

  async function run(start: number): Promise<void> {
    const gen = ++generation;
    state = 'playing';

    for (let i = start; i < items.length; i++) {
      if (gen !== generation) return;
      const item = items[i];
      if (!item) continue;
      index = i;
      options.onSentence(item.id);
      // Warm the next clips while this one is being rendered or is playing.
      prefetch(i + 1, gen);
      try {
        if (canSynthesize) await playAudioItem(item, gen);
        else await speakItem(item, gen);
      } catch (err) {
        if (gen !== generation || err instanceof AbortPlayback) return;
        state = 'idle';
        engine.stop();
        releaseAll();
        options.onError(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (gen !== generation) return;
    }

    if (gen === generation) {
      state = 'idle';
      options.onDone();
    }
  }

  /** Drop the current clip/utterance without changing the queue position. */
  function abort(): void {
    generation++;
    if (audio) {
      const el = audio;
      el.onended = null;
      el.onerror = null;
      el.pause();
      audio = null;
    }
    engine.stop();
  }

  function play(): void {
    if (state === 'playing') return; // never stack a second queue
    if (state === 'paused') {
      resume();
      return;
    }
    if (items.length === 0) {
      options.onDone();
      return;
    }
    void run(index);
  }

  function pause(): void {
    if (state !== 'playing') return;
    state = 'paused';
    if (audio) audio.pause();
    else engine.pause();
  }

  function resume(): void {
    if (state !== 'paused') return;
    state = 'playing';
    if (audio) {
      const el = audio;
      void el.play().catch((err: unknown) => {
        state = 'idle';
        engine.stop();
        options.onError(err instanceof Error ? err : new Error(String(err)));
      });
    } else {
      engine.resume();
    }
  }

  function stop(): void {
    state = 'idle';
    abort();
    releaseAll();
  }

  function seek(to: number): void {
    const next = clamp(to);
    const wasPlaying = state === 'playing';
    index = next;
    if (!wasPlaying) {
      // Idle or paused: drop what is sounding; play() starts at `next`.
      if (state === 'paused') {
        abort();
        state = 'idle';
      }
      return;
    }
    abort();
    void run(next);
  }

  return { play, pause, resume, stop, seek };
}
