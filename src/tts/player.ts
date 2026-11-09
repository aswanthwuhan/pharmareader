import type { AudioCacheRecord, TtsEngine } from '../core/types';
import { cacheKey, getAudio, putAudio, wavDurationMs } from './cache';
import { expand, lexiconVersion } from './lexicon';

export interface PlayerOptions {
  engine: TtsEngine;
  items: { id: string; text: string }[];
  startIndex?: number;
  voiceId?: string;
  rate: number;
  onSentence?(id: string): void;
  onDone?(): void;
  onError?(err: Error): void;
}

export interface Player {
  play(): void;
  pause(): void;
  resume(): void;
  stop(): void;
  seek(index: number): void;
}

/** Object URLs kept alive for retries/backtracking; each holds a whole clip. */
const URL_LRU_SIZE = 6;
const PREFETCH_AHEAD = 2;

/**
 * 44-byte silent WAV. Played muted from the tap handler that starts playback:
 * iOS and Android WebViews only allow later programmatic `play()` calls once
 * one has succeeded from a user gesture, and our real clip only exists after
 * an await (lexicon + cache + synthesis).
 */
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

class AbortPlayback extends Error {
  constructor() {
    super('playback superseded');
    this.name = 'AbortPlayback';
  }
}

type Item = { id: string; text: string };

export function createPlayer(options: PlayerOptions): Player {
  const { engine, items } = options;
  const canSynthesize = typeof engine.synthesize === 'function';

  let state: 'idle' | 'playing' | 'paused' = 'idle';
  let index = items.length === 0 ? 0 : Math.min(Math.max(0, Math.trunc(options.startIndex ?? 0)), items.length - 1);
  let generation = 0;
  let unlocked = false;

  let audio: HTMLAudioElement | null = null;
  let audioUrl: string | null = null;
  let audioKey: string | null = null;
  let settleClip: (() => void) | null = null;

  const urls = new Map<string, string>();
  const inflight = new Map<string, Promise<string>>();

  function report(err: unknown): void {
    options.onError?.(err instanceof Error ? err : new Error(String(err)));
  }

  function ensureAudio(): HTMLAudioElement {
    if (!audio) {
      audio = new Audio();
      audio.preload = 'auto';
    }
    return audio;
  }

  function startPlay(el: HTMLAudioElement): Promise<void> | undefined {
    const played = el.play();
    return played && typeof played.catch === 'function' ? played : undefined;
  }

  /** Must be called synchronously from the tap; see SILENT_WAV. */
  function primeAudio(): void {
    if (!canSynthesize || unlocked) return;
    unlocked = true;
    const el = ensureAudio();
    el.muted = true;
    el.src = SILENT_WAV;
    const played = startPlay(el);
    if (played) played.catch(() => {});
  }

  function detachClip(): void {
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
    }
    // Whoever awaits a clip that will never fire ended/error must still wake up.
    settleClip?.();
    settleClip = null;
  }

  function revokeAll(): void {
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
    inflight.clear();
    audioKey = null;
    audioUrl = null;
  }

  function evictOne(): boolean {
    for (const key of urls.keys()) {
      // The element still points at this URL; revoking it is harmless while
      // paused, but keeping it means a back/seek retry needs no synthesis.
      if (key === audioKey) continue;
      const url = urls.get(key);
      if (url === undefined) continue;
      urls.delete(key);
      URL.revokeObjectURL(url);
      return true;
    }
    return false;
  }

  function remember(key: string, blob: Blob): string {
    const known = urls.get(key);
    if (known !== undefined) {
      urls.delete(key);
      urls.set(key, known); // refresh its LRU position
      return known;
    }
    const url = URL.createObjectURL(blob);
    urls.set(key, url);
    while (urls.size > URL_LRU_SIZE && evictOne()) {
      /* trim */
    }
    return url;
  }

  async function audioUrlFor(item: Item, gen: number): Promise<{ key: string; url: string }> {
    const text = (await expand(item.text)) || item.text;
    if (gen !== generation) throw new AbortPlayback();
    const version = await lexiconVersion();
    if (gen !== generation) throw new AbortPlayback();
    const key = await cacheKey(text, engine.id, options.voiceId, options.rate, version);
    if (gen !== generation) throw new AbortPlayback();

    const cached = urls.get(key);
    if (cached !== undefined) return { key, url: cached };

    const pending = inflight.get(key);
    if (pending !== undefined) {
      try {
        return { key, url: await pending };
      } catch {
        // A prefetch may have died on a transient synth failure; the sentence
        // we need right now deserves its own attempt.
      }
      if (gen !== generation) throw new AbortPlayback();
    }

    const job = (async () => {
      const stored = await getAudio(key);
      if (gen !== generation) throw new AbortPlayback();
      if (stored) return remember(key, stored.audio);
      const blob = await engine.synthesize!(text, { voiceId: options.voiceId, rate: options.rate });
      if (gen !== generation) throw new AbortPlayback();
      const durationMs = await wavDurationMs(blob);
      const record: AudioCacheRecord = {
        key,
        engine: engine.id,
        audio: blob,
        durationMs,
        createdAt: Date.now(),
      };
      await putAudio(record);
      if (gen !== generation) throw new AbortPlayback();
      return remember(key, blob);
    })();
    inflight.set(key, job);
    try {
      return { key, url: await job };
    } finally {
      if (inflight.get(key) === job) inflight.delete(key);
    }
  }

  function prefetch(from: number, gen: number): void {
    const end = Math.min(items.length, from + PREFETCH_AHEAD);
    for (let i = from; i < end; i++) {
      const item = items[i];
      if (!item) continue;
      void audioUrlFor(item, gen).catch(() => {});
    }
  }

  function waitWhilePaused(gen: number): Promise<void> {
    if (state !== 'paused') return Promise.resolve();
    return new Promise((resolve) => {
      const tick = () => {
        if (gen !== generation || state !== 'paused') {
          resolve();
          return;
        }
        setTimeout(tick, 50);
      };
      setTimeout(tick, 50);
    });
  }

  async function playAudioItem(item: Item, gen: number): Promise<void> {
    const loaded = await audioUrlFor(item, gen);
    if (gen !== generation) throw new AbortPlayback();
    await waitWhilePaused(gen);
    if (gen !== generation) throw new AbortPlayback();

    const el = ensureAudio();
    detachClip();
    el.muted = false;
    el.src = loaded.url;
    audioKey = loaded.key;
    audioUrl = loaded.url;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        settleClip = null;
        audioUrl = null;
        resolve();
      };
      settleClip = finish;
      el.onended = finish;
      el.onerror = () => {
        if (settled) return;
        settled = true;
        settleClip = null;
        audioUrl = null;
        reject(new Error('Audio playback failed.'));
      };
      const played = startPlay(el);
      if (played) {
        played.catch((err: unknown) => {
          if (settled) return;
          settled = true;
          settleClip = null;
          audioUrl = null;
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      }
    });
  }

  async function speakItem(item: Item, gen: number): Promise<void> {
    const text = (await expand(item.text)) || item.text;
    if (gen !== generation) throw new AbortPlayback();
    await waitWhilePaused(gen);
    if (gen !== generation) throw new AbortPlayback();

    let failure: Error | null = null;
    await engine.speak([{ id: item.id, text }], { voiceId: options.voiceId, rate: options.rate }, {
      onError: (err) => {
        failure = err;
      },
    });
    if (gen !== generation) throw new AbortPlayback();
    if (failure) throw failure;
  }

  function abort(): void {
    generation++;
    detachClip();
    engine.stop();
  }

  async function run(start: number): Promise<void> {
    const gen = ++generation;
    state = 'playing';
    for (let i = start; i < items.length; i++) {
      if (gen !== generation) return;
      index = i;
      const item = items[i]!;
      options.onSentence?.(item.id);
      prefetch(i + 1, gen);
      try {
        if (canSynthesize) await playAudioItem(item, gen);
        else await speakItem(item, gen);
      } catch (err) {
        if (gen !== generation || err instanceof AbortPlayback) return;
        state = 'idle';
        abort();
        revokeAll();
        report(err);
        return;
      }
    }
    if (gen !== generation) return;
    state = 'idle';
    options.onDone?.();
  }

  function play(): void {
    if (items.length === 0) {
      options.onDone?.();
      return;
    }
    // Synchronous, inside the gesture: this is the autoplay unlock.
    primeAudio();
    if (state === 'playing') return;
    if (state === 'paused') {
      resume();
      return;
    }
    void run(index);
  }

  function pause(): void {
    if (state !== 'playing') return;
    state = 'paused';
    if (canSynthesize) {
      if (audio && audioUrl) audio.pause();
      // While a clip is still synthesising there is nothing to pause; the run
      // loop parks in waitWhilePaused until resume().
      return;
    }
    engine.pause();
  }

  function resume(): void {
    if (state !== 'paused') return;
    state = 'playing';
    if (!canSynthesize) {
      engine.resume();
      return;
    }
    if (audio && audioUrl) {
      audio.muted = false;
      const played = startPlay(audio);
      if (played) {
        played.catch((err: unknown) => {
          if (state !== 'playing') return;
          state = 'idle';
          abort();
          revokeAll();
          report(err);
        });
      }
    }
    // Else: a clip is being synthesised; run() continues when the poll wakes.
  }

  function stop(): void {
    state = 'idle';
    abort();
    revokeAll();
  }

  function seek(to: number): void {
    if (items.length === 0) return;
    const next = Math.min(Math.max(0, Math.trunc(to)), items.length - 1);
    const wasPlaying = state === 'playing';
    abort();
    index = next;
    if (wasPlaying) {
      void run(next);
      return;
    }
    // Paused/stopped: the next play() starts at the requested sentence.
    state = 'idle';
  }

  return { play, pause, resume, stop, seek };
}
