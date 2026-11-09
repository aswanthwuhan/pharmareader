import type { AudioCacheRecord, TtsEngine } from '../core/types';
import { cacheKey, getAudio, putAudio, wavDurationMs } from './cache';
import { expand, lexiconVersion } from './lexicon';
import { estimateTimings, wordTimings, type WordTiming } from './align';

/** What the reader is doing with one sentence of the queue. */
export type ItemState = 'queued' | 'generating' | 'ready' | 'playing' | 'done' | 'error';

export interface PlayerItem {
  id: string;
  /** The sentence as displayed; word-timing offsets are indexes into this. */
  text: string;
  /** What to say, when it differs (citations and brackets stripped). */
  spoken?: string;
  /** `charMap[i]` is the index in `text` of `spoken[i]`; highlighting needs it. */
  charMap?: number[];
  /** Silence to leave after this sentence, e.g. a paragraph pause. */
  pauseAfterMs?: number;
}

export interface PlayerOptions {
  engine: TtsEngine;
  items: PlayerItem[];
  startIndex?: number;
  voiceId?: string;
  rate: number;
  /** Fired when a sentence's audio actually starts — never while it is being rendered. */
  onSentence?(id: string, index: number): void;
  onItemState?(id: string, state: ItemState): void;
  /** How many upcoming clips are already rendered and waiting. */
  onBuffer?(readyAhead: number): void;
  /** Character index into the item's `text` of the word being spoken. */
  onWord?(id: string, charIndex: number): void;
  onDone?(): void;
  onError?(err: Error, id?: string): void;
}

export interface Player {
  play(): void;
  pause(): void;
  resume(): void;
  stop(): void;
  seek(index: number): void;
  /** Queue position: the sentence being prepared or spoken right now. */
  readonly index: number;
  /** Rendered clips waiting ahead of the queue position. */
  readonly bufferAhead: number;
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

type Item = PlayerItem;

interface Clip {
  key: string;
  url: string;
  blob: Blob;
  durationMs: number;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Slow, steady guess at how long one sentence takes to say. */
function assumedDurationMs(text: string, rate: number): number {
  const seconds = Math.max(0.6, text.length / (14 * Math.max(0.5, rate)));
  return seconds * 1000;
}

/** Locate the word containing `at` and return its first character. */
function wordStartAt(text: string, at: number): number {
  if (text.length === 0) return 0;
  let index = Math.min(Math.max(0, Math.round(at)), text.length - 1);
  while (index > 0 && !/\s/.test(text[index]!)) index--;
  while (index < text.length && /\s/.test(text[index]!)) index++;
  return index;
}

function charAtFraction(text: string, fraction: number): number {
  return wordStartAt(text, Math.min(1, Math.max(0, fraction)) * (text.length - 1));
}

export function createPlayer(options: PlayerOptions): Player {
  const { engine, items } = options;
  const canSynthesize = typeof engine.synthesize === 'function';

  let state: 'idle' | 'playing' | 'paused' = 'idle';
  /** Reading state through a call keeps TS from narrowing it to a literal. */
  const pausedNow = () => state === 'paused';
  let index = items.length === 0 ? 0 : Math.min(Math.max(0, Math.trunc(options.startIndex ?? 0)), items.length - 1);
  let generation = 0;
  let unlocked = false;

  let audio: HTMLAudioElement | null = null;
  let audioUrl: string | null = null;
  let audioKey: string | null = null;
  let settleClip: (() => void) | null = null;

  const urls = new Map<string, string>();
  const inflight = new Map<string, Promise<Clip>>();
  const states = new Map<string, ItemState>();
  const timings = new Map<string, Promise<WordTiming[]>>();

  function report(err: unknown, id?: string): void {
    options.onError?.(err instanceof Error ? err : new Error(String(err)), id);
  }

  function setState(item: Item, next: ItemState): void {
    if (states.get(item.id) === next) return;
    states.set(item.id, next);
    options.onItemState?.(item.id, next);
    options.onBuffer?.(bufferAhead());
  }

  /** Rendered clips ahead of the queue position (the hint the player shows). */
  function bufferAhead(): number {
    let count = 0;
    for (let i = index + 1; i < items.length; i++) {
      if (states.get(items[i]!.id) === 'ready') count++;
    }
    return count;
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
    timings.clear();
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

  async function audioClipFor(item: Item, gen: number): Promise<Clip> {
    const original = item.spoken ?? item.text;
    const text = (await expand(original)) || original;
    if (gen !== generation) throw new AbortPlayback();
    const version = await lexiconVersion();
    if (gen !== generation) throw new AbortPlayback();
    const key = await cacheKey(text, engine.id, options.voiceId, options.rate, version);
    if (gen !== generation) throw new AbortPlayback();

    const cached = urls.get(key);
    if (cached !== undefined) return { key, url: cached, blob: new Blob(), durationMs: 0 };

    const pending = inflight.get(key);
    if (pending !== undefined) {
      try {
        // A clip already being rendered for this exact text is worth waiting
        // for even if it was started for a queue position we have left.
        return await pending;
      } catch {
        // A prefetch may have died on a transient synth failure; the sentence
        // we need right now deserves its own attempt.
      }
    }

    setState(item, 'generating');
    const job = (async (): Promise<Clip> => {
      const stored = await getAudio(key);
      if (stored) {
        return { key, url: remember(key, stored.audio), blob: stored.audio, durationMs: stored.durationMs };
      }
      const blob = await engine.synthesize!(text, { voiceId: options.voiceId, rate: options.rate });
      const durationMs = await wavDurationMs(blob);
      const record: AudioCacheRecord = {
        key,
        engine: engine.id,
        audio: blob,
        durationMs,
        createdAt: Date.now(),
      };
      await putAudio(record);
      return { key, url: remember(key, blob), blob, durationMs };
    })();
    inflight.set(key, job);
    try {
      const clip = await job;
      if (states.get(item.id) !== 'playing') setState(item, 'ready');
      return clip;
    } catch (err) {
      if (err instanceof AbortPlayback) throw err;
      setState(item, 'error');
      throw err;
    } finally {
      if (inflight.get(key) === job) inflight.delete(key);
    }
  }

  function prefetch(from: number, gen: number): void {
    if (!canSynthesize) return; // a streaming voice renders as it speaks
    const end = Math.min(items.length, from + PREFETCH_AHEAD);
    for (let i = from; i < end; i++) {
      const item = items[i];
      if (!item) continue;
      if (states.get(item.id) === 'ready' || states.get(item.id) === 'generating') continue;
      setState(item, 'queued');
      void audioClipFor(item, gen).catch(() => {});
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

  /** Word timings for one clip, in the item's original-text coordinates. */
  function timingsFor(item: Item, clip: Clip): Promise<WordTiming[]> {
    const known = timings.get(item.id);
    if (known) return known;
    const spoken = item.spoken ?? item.text;
    if (!spoken.trim()) return Promise.resolve([]);
    const job = wordTimings(clip.blob, spoken, clip.durationMs || 1).catch(() => estimateTimings(spoken, 1));
    timings.set(item.id, job);
    return job;
  }

  /** Run `fn` on every frame, or on a slow timer where there are no frames. */
  function startClock(fn: () => void): () => void {
    if (typeof requestAnimationFrame === 'function' && typeof cancelAnimationFrame === 'function') {
      let frame = 0;
      const loop = () => {
        fn();
        frame = requestAnimationFrame(loop);
      };
      frame = requestAnimationFrame(loop);
      return () => cancelAnimationFrame(frame);
    }
    const timer = setInterval(fn, 100);
    return () => clearInterval(timer);
  }

  /** Fire onWord from the element clock, mapped back to the original sentence. */
  function followWords(item: Item, clip: Clip, gen: number, el: HTMLAudioElement): () => void {
    if (!options.onWord) return () => {};
    const spoken = item.spoken ?? item.text;
    const durationMs = clip.durationMs || 0;
    let last = -1;
    let stopped = false;
    let stopClock = () => {};

    const emit = (original: number) => {
      const word = wordStartAt(item.text, original);
      if (word === last) return;
      last = word;
      options.onWord?.(item.id, word);
    };

    // First pass: proportional to how much of the clip has been heard, so the
    // highlight moves even before alignment lands.
    let stopLength = startClock(() => {
      if (stopped || gen !== generation) return;
      const at = durationMs > 0 ? (el.currentTime * 1000) / durationMs : 0;
      const spokenIndex = Math.min(spoken.length - 1, Math.floor(at * spoken.length));
      emit(item.charMap?.[spokenIndex] ?? charAtFraction(item.text, at));
    });

    void timingsFor(item, clip).then((list) => {
      if (stopped || gen !== generation || list.length === 0) return;
      stopLength();
      stopLength = startClock(() => {
        if (stopped || gen !== generation || el.ended) return;
        const played = el.currentTime * 1000;
        let timing = list[0]!;
        for (const candidate of list) {
          if (candidate.startMs <= played) timing = candidate;
          else break;
        }
        emit(item.charMap?.[timing.charStart] ?? timing.charStart);
      });
    });

    stopClock = () => {
      stopped = true;
      stopLength();
    };
    return () => stopClock();
  }

  async function playAudioItem(i: number, gen: number): Promise<void> {
    const item = items[i]!;
    const clip = await audioClipFor(item, gen);
    if (gen !== generation) throw new AbortPlayback();
    // The sentence the reader is waiting for must not queue behind prefetches:
    // only start rendering ahead once this clip exists.
    prefetch(i + 1, gen);
    await waitWhilePaused(gen);
    if (gen !== generation) throw new AbortPlayback();

    const el = ensureAudio();
    detachClip();
    el.muted = false;
    el.src = clip.url;
    audioKey = clip.key;
    audioUrl = clip.url;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let stopWords = () => {};
      const finish = () => {
        if (settled) return;
        settled = true;
        settleClip = null;
        audioUrl = null;
        stopWords();
        resolve();
      };
      settleClip = finish;
      el.onended = finish;
      el.onerror = () => {
        if (settled) return;
        settled = true;
        settleClip = null;
        audioUrl = null;
        stopWords();
        reject(new Error('Audio playback failed.'));
      };
      // Only now does the sentence exist as sound: tell the reader which one it
      // is hearing, not which one the queue is preparing.
      options.onSentence?.(item.id, i);
      setState(item, 'playing');
      stopWords = followWords(item, clip, gen, el);
      const played = startPlay(el);
      if (played) {
        played.catch((err: unknown) => {
          if (settled) return;
          settled = true;
          settleClip = null;
          audioUrl = null;
          stopWords();
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      }
    });
  }

  async function speakItem(i: number, gen: number): Promise<void> {
    const item = items[i]!;
    const spoken = item.spoken ?? item.text;
    const text = (await expand(spoken)) || spoken;
    if (gen !== generation) throw new AbortPlayback();
    await waitWhilePaused(gen);
    if (gen !== generation) throw new AbortPlayback();

    const expected = assumedDurationMs(text, options.rate);
    let startedAt = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    let last = -1;
    const stopWords = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const emit = (original: number) => {
      const word = wordStartAt(item.text, original);
      if (word === last) return;
      last = word;
      options.onWord?.(item.id, word);
    };

    options.onSentence?.(item.id, i);
    setState(item, 'playing');
    if (options.onWord) {
      // The native phone voice reports no boundaries; the web one does. Until a
      // boundary arrives, walk the sentence by elapsed time.
      timer = setInterval(() => {
        if (gen !== generation) return;
        const elapsed = startedAt ? Date.now() - startedAt : 0;
        emit(charAtFraction(item.text, elapsed / expected));
      }, 160);
    }

    let failure: Error | null = null;
    try {
      await engine.speak([{ id: item.id, text }], { voiceId: options.voiceId, rate: options.rate }, {
        onStart: () => {
          startedAt = Date.now();
        },
        onWord: (_id, charIndex) => {
          if (!options.onWord) return;
          // Boundary offsets index the expanded utterance; relate them to the
          // sentence the reader sees by proportion.
          emit(charAtFraction(item.text, charIndex / Math.max(1, text.length)));
        },
        onError: (err) => {
          failure = err;
        },
      });
    } finally {
      stopWords();
    }
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
      try {
        if (canSynthesize) await playAudioItem(i, gen);
        else await speakItem(i, gen);
      } catch (err) {
        if (gen !== generation || err instanceof AbortPlayback) return;
        setState(item, 'error');
        state = 'idle';
        abort();
        revokeAll();
        report(err, item.id);
        return;
      }
      if (gen !== generation) return;
      setState(item, 'done');
      const gap = item.pauseAfterMs ?? 0;
      if (gap > 0 && i + 1 < items.length) {
        if (pausedNow()) await waitWhilePaused(gen);
        if (gen !== generation) return;
        await delay(gap);
        if (gen !== generation) return;
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
    const current = items[index];
    state = 'idle';
    abort();
    revokeAll();
    if (current && states.get(current.id) !== 'done') setState(current, 'queued');
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

  return {
    play,
    pause,
    resume,
    stop,
    seek,
    get index() {
      return index;
    },
    get bufferAhead() {
      return bufferAhead();
    },
  };
}
