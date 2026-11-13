import type { AudioCacheRecord, TtsEngine } from '../core/types';
import { cacheKey, getAudio, putAudio, wavDurationMs } from './cache';
import { cacheVoiceId } from './cacheIdentity';
import { expand } from './lexicon';
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
  /**
   * How many sentences to render ahead of the one being spoken (1–20, default 3).
   * A big look-ahead is a long synthesis burst at every chapter start.
   */
  prefetchAhead?: number;
  /** Fired when a sentence's audio actually starts — never while it is being rendered. */
  onSentence?(id: string, index: number): void;
  onItemState?(id: string, state: ItemState): void;
  /** How many upcoming clips are already rendered and waiting. */
  onBuffer?(readyAhead: number): void;
  /**
   * False when the reader is not following the words. Neither the word clock nor
   * the Whisper alignment runs then: alignment is a second model on the phone.
   */
  wordHighlight?: boolean;
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

/** Rendered ahead of the playing sentence before playback starts to wait. */
const PREFETCH_AHEAD_DEFAULT = 3;
const PREFETCH_AHEAD_MIN = 1;
const PREFETCH_AHEAD_MAX = 20;
/** Object URLs kept beyond the look-ahead, for back/seek retries. */
const URL_LRU_EXTRA = 4;
/**
 * How often the word clock looks at the audio position: 15 checks a second. A
 * word lasts far longer than 66 ms, so a 60 fps loop for the whole clip only
 * keeps the WebView's main thread awake.
 */
const WORD_CLOCK_MS = 66;

function clampPrefetchAhead(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return PREFETCH_AHEAD_DEFAULT;
  return Math.min(Math.max(Math.trunc(value), PREFETCH_AHEAD_MIN), PREFETCH_AHEAD_MAX);
}

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

/**
 * Kokoro native words a cancelled job "… was cancelled", and shares one cancel
 * epoch between playback and pre-render, so a cancel can belong to the other
 * caller. A cancel we did not ask for is worth one retry.
 */
function isCancel(err: unknown): boolean {
  return /cancel/i.test(err instanceof Error ? err.message : String(err));
}

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
  const prefetchAhead = clampPrefetchAhead(options.prefetchAhead);
  /**
   * Word following costs a whole second model (Whisper alignment) and a clock
   * on the main thread, so it runs only when a caller both asked for it and
   * supplied somewhere to send the words.
   */
  const wordsWanted = options.wordHighlight !== false && options.onWord !== undefined;
  /** The in-memory clip cache covers the look-ahead and a little history. */
  const urlLruSize = prefetchAhead + URL_LRU_EXTRA;

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

  const clips = new Map<string, Clip>();
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
    if (unlocked) return;
    unlocked = true;
    // Safari 17+: play like a media app, so the iPhone's silent switch does not mute reading.
    const session = (navigator as { audioSession?: { type: string } }).audioSession;
    if (session) session.type = 'playback';
    if (!canSynthesize) {
      // iOS Safari keeps speechSynthesis silent unless its first speak() runs
      // inside the tap; the real utterance comes after IndexedDB/voice awaits.
      try {
        if (typeof SpeechSynthesisUtterance !== 'undefined') {
          globalThis.speechSynthesis?.speak(new SpeechSynthesisUtterance(''));
        }
      } catch {
        // an unlock that throws must not stop playback from starting
      }
      return;
    }
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
    for (const clip of clips.values()) URL.revokeObjectURL(clip.url);
    clips.clear();
    inflight.clear();
    timings.clear();
    audioKey = null;
    audioUrl = null;
  }

  function evictOne(): boolean {
    for (const key of clips.keys()) {
      // The element still points at this URL; revoking it is harmless while
      // paused, but keeping it means a back/seek retry needs no synthesis.
      if (key === audioKey) continue;
      const clip = clips.get(key);
      if (clip === undefined) continue;
      clips.delete(key);
      URL.revokeObjectURL(clip.url);
      return true;
    }
    return false;
  }

  /**
   * Remember a clip — URL included — and return it. Word timing needs the blob
   * and the duration, so the URL alone is not enough to serve.
   */
  function remember(clip: Omit<Clip, 'url'>): Clip {
    const known = clips.get(clip.key);
    if (known !== undefined) {
      clips.delete(clip.key);
      clips.set(clip.key, known); // refresh its LRU position
      return known;
    }
    const stored: Clip = { ...clip, url: URL.createObjectURL(clip.blob) };
    clips.set(clip.key, stored);
    while (clips.size > urlLruSize && evictOne()) {
      /* trim */
    }
    return stored;
  }

  /** Synthesize one sentence, retrying once when the engine cancelled it for us. */
  async function synthesizeForItem(text: string, gen: number): Promise<Blob> {
    // Bound: the neural engines keep `synthesize` on the prototype and it starts
    // with `this.prepare()` (kokoro) / `this.ensure()` (pocket), so a detached
    // call throws "Cannot read properties of undefined (reading 'prepare')".
    const synthesize = engine.synthesize!.bind(engine);
    const request = { voiceId: options.voiceId, rate: options.rate };
    try {
      return await synthesize(text, request);
    } catch (err) {
      if (gen !== generation || !isCancel(err)) throw err;
      return await synthesize(text, request);
    }
  }

  async function audioClipFor(item: Item, gen: number): Promise<Clip> {
    const original = item.spoken ?? item.text;
    const text = (await expand(original, engine.id)) || original;
    if (gen !== generation) throw new AbortPlayback();
    // Kokoro's precision is part of the identity: q8 and fp32 clips must not mix.
    const voiceId = await cacheVoiceId(engine, options.voiceId);
    const key = await cacheKey(text, engine.id, voiceId, options.rate);
    if (gen !== generation) throw new AbortPlayback();

    const cached = clips.get(key);
    // The whole clip, not just its URL: a prefetched sentence is the normal
    // case, and an empty blob with a 0 ms duration pins the word mark to word 0.
    if (cached !== undefined) return remember(cached);

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
        // A stop/seek that landed while this row was read already revoked every
        // URL; the row stays in the cache for the next play.
        if (gen !== generation) throw new AbortPlayback();
        return remember({ key, blob: stored.audio, durationMs: stored.durationMs });
      }
      const blob = await synthesizeForItem(text, gen);
      const durationMs = await wavDurationMs(blob);
      const record: AudioCacheRecord = {
        key,
        engine: engine.id,
        audio: blob,
        durationMs,
        createdAt: Date.now(),
      };
      await putAudio(record);
      // The audio is in the cache now; a stop/seek that landed while it was
      // rendering must not leave behind an object URL nothing will revoke.
      if (gen !== generation) throw new AbortPlayback();
      return remember({ key, blob, durationMs });
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

  /**
   * The nearest upcoming sentence that still needs a clip. The look-ahead fills
   * in order, so the sentence the reader will reach next is prepared first and a
   * seek never waits behind a queue of later ones.
   */
  function nextPrefetchItem(): Item | null {
    const end = Math.min(items.length, index + 1 + prefetchAhead);
    for (let i = index + 1; i < end; i++) {
      const item = items[i];
      if (!item) continue;
      const known = states.get(item.id);
      if (known === 'ready' || known === 'playing' || known === 'done' || known === 'error') continue;
      return item;
    }
    return null;
  }

  let prefetching = false;
  let prefetchAgain = false;

  /**
   * Render the look-ahead one clip at a time. The engine is single-threaded, so
   * starting N renders at once would put the sentence the reader is waiting for
   * at the back of a long queue; the chain dies with its generation on a
   * seek/stop and is restarted by the next play.
   *
   * It also stops outside `playing`: a paused player has no reader waiting for
   * the next clip, so synthesising one is heat for nothing. The clip already in
   * the engine is allowed to finish; resume() starts the chain again.
   */
  function prefetch(): void {
    if (!canSynthesize) return; // a streaming voice renders as it speaks
    if (prefetching) {
      // A seek or an advance happened mid-chain: look again when this pass ends.
      prefetchAgain = true;
      return;
    }
    prefetching = true;
    void (async () => {
      try {
        do {
          prefetchAgain = false;
          const gen = generation;
          for (;;) {
            if (state !== 'playing' || gen !== generation) break;
            const item = nextPrefetchItem();
            if (!item) break;
            setState(item, 'queued');
            try {
              await audioClipFor(item, gen);
            } catch {
              // Aborted by a seek/stop, or this clip failed: a queued pass (if
              // any) starts over from wherever the queue is now.
              break;
            }
            if (gen !== generation) break;
          }
        } while (prefetchAgain && state === 'playing' && canSynthesize);
      } finally {
        prefetching = false;
      }
    })();
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
    // A clip with no measurable duration (an empty or unknown-length WAV) has no
    // word timing worth asking Whisper for: estimate from the text instead.
    const job =
      clip.durationMs > 1
        ? wordTimings(clip.blob, spoken, clip.durationMs).catch(() => estimateTimings(spoken, 1))
        : Promise.resolve(estimateTimings(spoken, 1));
    timings.set(item.id, job);
    return job;
  }

  /**
   * Run `fn` about every 66 ms — 15 checks a second — instead of on every frame.
   * Word highlighting only needs to know which word is being said, and a word
   * lasts hundreds of milliseconds; a 60 fps loop would wake the WebView main
   * thread 60 times a second for the whole clip.
   */
  function startClock(fn: () => void): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = () => {
      if (stopped) return;
      fn();
      timer = setTimeout(loop, WORD_CLOCK_MS);
    };
    timer = setTimeout(loop, WORD_CLOCK_MS);
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }

  /** Fire onWord from the element clock, mapped back to the original sentence. */
  function followWords(item: Item, clip: Clip, gen: number, el: HTMLAudioElement): () => void {
    if (!wordsWanted) return () => {};
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
    // Protect this clip's URL before the prefetch below can evict it: it is not
    // loaded in the element yet, so evictOne would not know to spare it.
    audioKey = clip.key;
    // The sentence the reader is waiting for must not queue behind prefetches:
    // only start rendering ahead once this clip exists.
    prefetch();
    await waitWhilePaused(gen);
    if (gen !== generation) throw new AbortPlayback();

    const el = ensureAudio();
    detachClip();
    el.muted = false;
    el.src = clip.url;
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
    const text = (await expand(spoken, engine.id)) || spoken;
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
    if (wordsWanted) {
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
          if (!wordsWanted) return;
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
    // Pausing stopped the look-ahead chain, so it starts again from here.
    prefetch();
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
