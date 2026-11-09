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
import { setModelReady } from './models';
import { ORT_BASE_URL } from './ort';
import { FloatPlayer } from './playback';
import { createProgressAggregator } from './progress';
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
  private stopped = false;
  /** Bumped by `speak`/`stop` so a superseded utterance cannot resume playback. */
  private generation = 0;
  /** Bumped by `reset()` so a download in flight cannot install its model afterwards. */
  private epoch = 0;

  async isReady(): Promise<boolean> {
    return this.tts?.ready === true;
  }

  async prepare(onProgress?: (fraction: number) => void): Promise<void> {
    if (this.tts?.ready) return;
    const pending = (this.loading ??= this.load(onProgress));
    try {
      await pending;
    } catch (err) {
      if (this.loading === pending) this.loading = null;
      throw err;
    }
  }

  private async load(onProgress?: (fraction: number) => void): Promise<PocketTTS> {
    const epoch = this.epoch;
    const tts = new PocketTTS({
      language: LANGUAGE,
      quantized: true, // INT8: the phone-sized variant
      voiceCloning: false, // built-in voices only, skips the ~21 MB encoder
      cache: true, // Cache Storage: later loads are offline
      ortBaseUrl: ORT_BASE_URL, // onnxruntime-web from public/ort, never jsDelivr
    });
    const report = createProgressAggregator(onProgress);
    try {
      await tts.load((info: ProgressInfo) => report(info));
    } catch (err) {
      tts.destroy();
      throw err;
    }
    if (epoch !== this.epoch) {
      // `reset()` ran while the weights were downloading: do not keep them.
      tts.destroy();
      throw new Error('Pocket TTS download was cancelled');
    }
    this.tts = tts;
    await setModelReady('pocket', true);
    onProgress?.(1);
    return tts;
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
      if (!this.stopped && generation === this.generation) ev.onError?.(asError(err));
      return;
    }
    // `stop()` can land while the model downloads or a voice is prepared.
    if (this.stopped || generation !== this.generation) return;

    await this.player.resume(); // speak() is called from a user gesture
    if (this.stopped || generation !== this.generation) return;

    let next = this.render(tts, items[0].text, voice);
    next.catch(() => {}); // a stop mid-render must not surface as unhandled

    for (let i = 0; i < items.length; i++) {
      let pcm: Pcm;
      try {
        pcm = await next;
      } catch (err) {
        if (!this.stopped && generation === this.generation) ev.onError?.(asError(err));
        return;
      }
      if (this.stopped || generation !== this.generation) return;

      if (i + 1 < items.length) {
        next = this.render(tts, items[i + 1].text, voice);
        next.catch(() => {});
      }

      ev.onStart?.(items[i].id);
      try {
        await this.player.play(pcm.data, pcm.sampleRate, rate);
      } catch (err) {
        if (!this.stopped && generation === this.generation) ev.onError?.(asError(err));
        return;
      }
      ev.onEnd?.(items[i].id);
      if (this.stopped || generation !== this.generation) return;
    }
  }

  async synthesize(text: string, opts: { voiceId?: string; rate: number }): Promise<Blob> {
    const tts = await this.ensure();
    const voice = await this.voiceRef(tts, opts.voiceId);
    const pcm = await this.render(tts, text, voice);
    if (pcm.stopped) throw new Error('Pocket TTS synthesis was stopped');
    // The model has no speed input, so `rate` is baked into the samples here —
    // the shared player plays cached clips at 1x, so the file must already be
    // at the requested speed.
    return encodeWav(changeSpeed(pcm.data, clampPocketRate(opts.rate)), pcm.sampleRate);
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
    this.voices.clear();
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

  private async render(tts: PocketTTS, text: string, voice: string): Promise<Pcm> {
    const chunks: Float32Array[] = [];
    const metrics: GenerationMetrics = await tts.generate(text, { voice, onChunk: (audio) => chunks.push(audio) });
    return { data: concatFloat32(chunks), sampleRate: tts.sampleRate, stopped: metrics.stopped === true };
  }
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export const pocketEngine: TtsEngine = new PocketEngine();

/** Reset the loaded model (the panel calls this after deleting the download). */
export function resetPocketEngine(): void {
  (pocketEngine as PocketEngine).reset();
}
