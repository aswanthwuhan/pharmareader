/**
 * Pocket TTS (Kyutai) — streaming, on-device, INT8 ONNX.
 *
 * `pocket-tts-js` owns its own Web Worker and streams Float32 chunks from it;
 * there is no speed argument in the model, so `rate` is applied as playbackRate.
 * Sentences are rendered one ahead of playback: while sentence N plays the
 * worker is already synthesising N+1, which hides the model latency on phones.
 * Built-in voices only — voice cloning stays out of the app (gated weights).
 */
import { PocketTTS, type GenerationMetrics, type ProgressInfo } from 'pocket-tts-js';
import { getSetting } from '../../core/settings';
import type { SpeakEvents, TtsEngine, TtsVoice } from '../../core/types';
import { planChunks, splitIntoClauses } from './clauseChunk';
import { POCKET_SIZE_MB, isModelDownloaded, setModelReady } from './models';
import { NEURAL_STAGES, neuralError } from './neuralError';
import { ORT_BASE_URL } from './ort';
import { FloatPlayer } from './playback';
import { createProgressAggregator } from './progress';
import { wasmThreadCount } from './threadBudget';
import { changeSpeed, concatFloat32, encodeWav } from './wav';

/** The only language bundle the app supports for now (Indian English readers). */
const LANGUAGE = 'english_2026-04';
const VOICE_SETTING = 'tts.pocket.voice';

/**
 * Pocket has no speed input, so speed is resampling: pitch rises and falls with
 * rate. Beyond this range speech sounds chipmunky, so the panel advertises and
 * the engine enforces these bounds for Pocket (other engines go to 0.5–2).
 */
export const POCKET_RATE_MIN = 0.8;
export const POCKET_RATE_MAX = 1.25;

export function clampPocketRate(rate: number): number {
  if (!(rate > 0)) return 1;
  return Math.min(POCKET_RATE_MAX, Math.max(POCKET_RATE_MIN, rate));
}

interface Pcm {
  data: Float32Array;
  sampleRate: number;
  /** The library cut generation short because `stop()` was called. */
  stopped: boolean;
}

class PocketEngine implements TtsEngine {
  readonly id = 'pocket' as const;
  readonly label = 'Pocket TTS (on device)';
  readonly capabilities = {
    streaming: true,
    prerender: true,
    wordBoundaries: false,
    needsDownload: true,
  } as const;

  private tts: PocketTTS | null = null;
  private loading: Promise<PocketTTS> | null = null;
  private readonly voices = new Map<string, Promise<string>>();
  private readonly player = new FloatPlayer();
  /**
   * One download, many watchers: the settings panel that started it, the reader that
   * asked for a voice meanwhile, and a remounted panel all subscribe here. A single
   * `onProgress` field meant the second caller silently got no progress.
   */
  private readonly progressListeners = new Set<(fraction: number) => void>();
  /**
   * `tts.generate()` is not re-entrant: the worker runs one job at a time and a
   * second concurrent call comes back with no audio chunks at all (a 44-byte,
   * zero-length WAV). The player prefetches two sentences ahead, so every
   * generation is chained on this promise instead.
   */
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  /** Bumped by `speak`/`stop` so a superseded utterance cannot resume playback. */
  private generation = 0;
  /** Bumped by `reset()` so a download in flight cannot install its model afterwards. */
  private epoch = 0;

  async isReady(): Promise<boolean> {
    if (this.tts?.ready === true) return true;
    // A reload drops the in-memory model but keeps the 178 MB download, so the
    // engine must still count as ready: the reader picks it and prepare() loads the
    // cached files. Reporting false here made every reload silently fall back to the
    // system voice even though Settings showed "Ready".
    return isModelDownloaded('pocket');
  }

  async prepare(onProgress?: (fraction: number) => void): Promise<void> {
    if (this.tts?.ready) {
      onProgress?.(1);
      return;
    }
    if (onProgress) this.progressListeners.add(onProgress);
    const pending = (this.loading ??= this.load());
    try {
      await pending;
    } catch (err) {
      // The attempt is over: nobody is going to receive progress for it any more.
      this.progressListeners.clear();
      if (this.loading === pending) this.loading = null;
      throw err;
    }
  }

  /**
   * A Pocket clip is identified by the voice it was rendered in: the same sentence in
   * another voice is another clip, so a voice change must not replay the old one.
   *
   * The library's voice list only exists once the model has loaded, so the name here is
   * the saved (or requested) one rather than `voiceRef()`'s fallback: the panel only
   * stores a name it was given, and an empty setting means the first built-in voice —
   * one clip, whatever that voice is called. If a saved name ever dropped out of the
   * library's list, its clips would be rendered again in the first voice under a new
   * key: extra work, never a replay in the wrong voice.
   */
  async cacheVariant(voiceId?: string): Promise<string> {
    const saved = voiceId ?? (await getSetting<string>(VOICE_SETTING, ''));
    // `chunked` marks the clips rendered after `synthesize()` learned to voice a
    // long sentence clause by clause. Clips cached before that change have their
    // last words missing, and a stale key would keep replaying them.
    return `${saved || 'default'}@chunked`;
  }

  private async load(): Promise<PocketTTS> {
    const epoch = this.epoch;
    const tts = new PocketTTS({
      language: LANGUAGE,
      quantized: true, // INT8: the phone-sized variant
      voiceCloning: false, // built-in voices only, skips the ~21 MB encoder
      cache: hasCacheStorage(), // Cache Storage: later loads are offline
      ortBaseUrl: ORT_BASE_URL, // onnxruntime-web from public/ort, never jsDelivr
      // WASM thread cap. pocket-tts-js reads `self.crossOriginIsolated` itself and stays
      // single-threaded without it, so this only bounds the thread pool once a browser
      // isolates the page (Android's WebView does not — docs/PERFORMANCE.md).
      maxThreads: wasmThreadCount(),
    });
    const report = createProgressAggregator((fraction) => this.emitProgress(fraction), POCKET_SIZE_MB * 1e6);
    let sawProgress = false;
    try {
      await tts.load((info: ProgressInfo) => {
        sawProgress = true;
        report(info);
      });
    } catch (err) {
      tts.destroy();
      // Before the first progress event the worker itself failed to start.
      throw neuralError('pocket', sawProgress ? NEURAL_STAGES.files : NEURAL_STAGES.worker, err);
    }
    if (epoch !== this.epoch) {
      // `reset()` ran while the weights were downloading: do not keep them.
      tts.destroy();
      throw new Error('Pocket TTS download was cancelled');
    }
    // `voices.bin` (52 MB) is fetched by the first `loadVoice()`. Doing it here
    // means "Ready" means speakable: the first Play would otherwise stall for a
    // minute on a phone, silently, because nothing reports that download.
    try {
      await this.voiceRef(tts);
    } catch (err) {
      tts.destroy();
      throw neuralError('pocket', NEURAL_STAGES.voices, err);
    }
    this.tts = tts;
    await setModelReady('pocket', true);
    this.emitProgress(1);
    // Do not retain the panels' progress callbacks once the download is over
    // (Kokoro's init clears them in a `finally`; a success here kept them forever).
    this.progressListeners.clear();
    return tts;
  }

  private emitProgress(fraction: number): void {
    for (const listener of [...this.progressListeners]) {
      try {
        listener(fraction);
      } catch {
        /* a watcher that throws must not break the load */
      }
    }
  }

  async listVoices(): Promise<TtsVoice[]> {
    const tts = this.tts;
    if (!tts?.ready) return [];
    return tts.predefinedVoices.map((name) => ({
      id: name,
      name: name.charAt(0).toUpperCase() + name.slice(1),
      lang: 'en',
    }));
  }

  async speak(
    items: { id: string; text: string }[],
    opts: { voiceId?: string; rate: number },
    ev: SpeakEvents
  ): Promise<void> {
    if (items.length === 0) return;
    this.stopped = false;
    const generation = ++this.generation;
    const rate = clampPocketRate(opts.rate);

    let tts: PocketTTS;
    let voice: string;
    try {
      tts = await this.ensure();
      if (this.stopped || generation !== this.generation) return;
      voice = await this.voiceRef(tts, opts.voiceId);
    } catch (err) {
      if (!this.stopped && generation === this.generation) ev.onError?.(neuralError('pocket', NEURAL_STAGES.model, err));
      return;
    }
    // `stop()` can land while the model downloads or a voice is prepared.
    if (this.stopped || generation !== this.generation) return;

    await this.player.resume(); // speak() is called from a user gesture
    if (this.stopped || generation !== this.generation) return;

    // Long sentences are voiced clause by clause, so playback can start after the
    // first clause instead of after the whole sentence (~20 s at RTF 3).
    const plan = planChunks(items);
    if (plan.length === 0) return;

    let next = this.render(tts, plan[0].text, voice);
    next.catch(() => {}); // a stop mid-render must not surface as unhandled

    for (let i = 0; i < plan.length; i++) {
      let pcm: Pcm;
      try {
        pcm = await next;
      } catch (err) {
        if (!this.stopped && generation === this.generation) ev.onError?.(neuralError('pocket', NEURAL_STAGES.synth, err));
        return;
      }
      if (this.stopped || generation !== this.generation) return;

      if (i + 1 < plan.length) {
        next = this.render(tts, plan[i + 1].text, voice);
        next.catch(() => {});
      }

      if (plan[i].first) ev.onStart?.(plan[i].itemId);
      try {
        await this.player.play(pcm.data, pcm.sampleRate, rate);
      } catch (err) {
        if (!this.stopped && generation === this.generation) ev.onError?.(neuralError('pocket', NEURAL_STAGES.play, err));
        return;
      }
      if (plan[i].last) ev.onEnd?.(plan[i].itemId);
      if (this.stopped || generation !== this.generation) return;
    }
  }

  async synthesize(text: string, opts: { voiceId?: string; rate: number }): Promise<Blob> {
    try {
      const tts = await this.ensure();
      const voice = await this.voiceRef(tts, opts.voiceId);
      // The model stops after a bounded number of frames, so a long sentence sent
      // in one call comes back short: the last words are simply missing ("it
      // trails off"). `speak()` already voices long sentences clause by clause;
      // the cached/pre-rendered path has to cut the same way, or it caches that
      // shortened clip and every replay keeps the missing words.
      const parts: Float32Array[] = [];
      for (const clause of splitIntoClauses(text)) {
        const pcm = await this.render(tts, clause, voice);
        if (pcm.stopped) throw new Error('Pocket TTS synthesis was stopped');
        parts.push(pcm.data);
      }
      if (parts.length === 0) throw new Error('Pocket TTS produced no audio for this text');
      // The model has no speed input, so `rate` is baked into the samples here —
      // the shared player plays cached clips at 1x, so the file must already be
      // at the requested speed.
      return encodeWav(changeSpeed(concatFloat32(parts), clampPocketRate(opts.rate)), tts.sampleRate);
    } catch (err) {
      throw neuralError('pocket', NEURAL_STAGES.synth, err);
    }
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    this.player.stop();
    void this.tts?.stop().catch(() => {});
  }

  pause(): void {
    this.player.pause();
  }

  resume(): void {
    this.player.resume();
  }

  /** Drop the worker and in-memory model (used after deleting the download). */
  reset(): void {
    this.epoch++;
    this.stop();
    this.tts?.destroy();
    this.tts = null;
    this.loading = null;
    this.progressListeners.clear();
    this.voices.clear();
    this.queue = Promise.resolve();
    void this.player.dispose();
  }

  private async ensure(): Promise<PocketTTS> {
    if (this.tts?.ready) return this.tts;
    await this.prepare();
    if (!this.tts) throw new Error('Pocket TTS failed to load');
    return this.tts;
  }

  private async voiceRef(tts: PocketTTS, requested?: string): Promise<string> {
    const saved = requested ?? (await getSetting<string>(VOICE_SETTING, ''));
    const name = tts.predefinedVoices.includes(saved) ? saved : tts.predefinedVoices[0];
    if (!name) throw new Error('Pocket TTS reported no built-in voices');
    let ref = this.voices.get(name);
    if (!ref) {
      ref = tts.loadVoice(name).catch((err: unknown) => {
        this.voices.delete(name); // let the next attempt retry the download
        throw err;
      });
      this.voices.set(name, ref);
    }
    return ref;
  }

  private render(tts: PocketTTS, text: string, voice: string): Promise<Pcm> {
    const run = this.queue.then(() => this.renderNow(tts, text, voice));
    // The chain must never reject, or one failed sentence would poison the queue.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async renderNow(tts: PocketTTS, text: string, voice: string): Promise<Pcm> {
    const chunks: Float32Array[] = [];
    const metrics: GenerationMetrics = await tts.generate(text, { voice, onChunk: (audio) => chunks.push(audio) });
    const data = concatFloat32(chunks);
    if (data.length === 0 && metrics.stopped !== true) {
      // Never hand the player an empty clip: it would "end" instantly at 0:00 and
      // the reader would advance through the book in silence with no error.
      throw new Error('Pocket TTS produced no audio for this text');
    }
    return { data, sampleRate: tts.sampleRate, stopped: metrics.stopped === true };
  }
}

export const pocketEngine: TtsEngine = new PocketEngine();

/**
 * Cache Storage is what makes the second launch offline, but it is missing in
 * private mode and in some old Android WebViews: asking the library to use it
 * there turns a working download into "TypeError: caches is undefined".
 */
export function hasCacheStorage(): boolean {
  return typeof caches !== 'undefined';
}

/** Reset the loaded model (the panel calls this after deleting the download). */
export function resetPocketEngine(): void {
  (pocketEngine as PocketEngine).reset();
}
