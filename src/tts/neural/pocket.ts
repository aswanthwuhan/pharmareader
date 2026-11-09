/**
 * Pocket TTS (Kyutai) — streaming, on-device, INT8 ONNX.
 *
 * `pocket-tts-js` owns its own Web Worker and streams Float32 chunks from it;
 * there is no speed argument in the model, so `rate` is applied as playbackRate.
 * Sentences are rendered one ahead of playback: while sentence N plays the
 * worker is already synthesising N+1, which hides the model latency on phones.
 * Built-in voices only — voice cloning stays out of the app (gated weights).
 */
import { PocketTTS, type ProgressInfo } from 'pocket-tts-js';
import { getSetting } from '../../core/settings';
import type { SpeakEvents, TtsEngine, TtsVoice } from '../../core/types';
import { setModelReady } from './models';
import { FloatPlayer } from './playback';
import { createProgressAggregator } from './progress';
import { changeSpeed, concatFloat32, encodeWav } from './wav';

/** The only language bundle the app supports for now (Indian English readers). */
const LANGUAGE = 'english_2026-04';
const VOICE_SETTING = 'tts.pocket.voice';

interface Pcm {
  data: Float32Array;
  sampleRate: number;
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

  async isReady(): Promise<boolean> {
    return this.tts?.ready === true;
  }

  async prepare(onProgress?: (fraction: number) => void): Promise<void> {
    if (this.tts?.ready) return;
    this.loading ??= this.load(onProgress);
    try {
      await this.loading;
    } catch (err) {
      this.loading = null;
      throw err;
    }
  }

  private async load(onProgress?: (fraction: number) => void): Promise<PocketTTS> {
    const tts = new PocketTTS({
      language: LANGUAGE,
      quantized: true, // INT8: the phone-sized variant
      voiceCloning: false, // built-in voices only, skips the ~21 MB encoder
      cache: true,
    });
    const report = createProgressAggregator(onProgress);
    try {
      await tts.load((info: ProgressInfo) => report(info));
    } catch (err) {
      tts.destroy();
      throw err;
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

    let tts: PocketTTS;
    let voice: string;
    const rate = opts.rate > 0 ? opts.rate : 1;
    try {
      tts = await this.ensure();
      voice = await this.voiceRef(tts, opts.voiceId);
    } catch (err) {
      ev.onError?.(asError(err));
      return;
    }

    await this.player.resume(); // speak() is called from a user gesture

    let next = this.render(tts, items[0].text, voice);
    next.catch(() => {}); // a stop mid-render must not surface as unhandled

    for (let i = 0; i < items.length; i++) {
      let pcm: Pcm;
      try {
        pcm = await next;
      } catch (err) {
        if (!this.stopped) ev.onError?.(asError(err));
        return;
      }
      if (this.stopped) return;

      if (i + 1 < items.length) {
        next = this.render(tts, items[i + 1].text, voice);
        next.catch(() => {});
      }

      ev.onStart?.(items[i].id);
      await this.player.play(pcm.data, pcm.sampleRate, rate);
      ev.onEnd?.(items[i].id);
      if (this.stopped) return;
    }
  }

  async synthesize(text: string, opts: { voiceId?: string; rate: number }): Promise<Blob> {
    const tts = await this.ensure();
    const voice = await this.voiceRef(tts, opts.voiceId);
    const pcm = await this.render(tts, text, voice);
    // The model has no speed input, so `rate` is baked into the samples here —
    // the shared player plays cached clips at 1x, so the file must already be
    // at the requested speed.
    const rate = opts.rate > 0 ? opts.rate : 1;
    return encodeWav(changeSpeed(pcm.data, rate), pcm.sampleRate);
  }

  stop(): void {
    this.stopped = true;
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
      ref = tts.loadVoice(name);
      this.voices.set(name, ref);
    }
    return ref;
  }

  private async render(tts: PocketTTS, text: string, voice: string): Promise<Pcm> {
    const chunks: Float32Array[] = [];
    await tts.generate(text, { voice, onChunk: (audio) => chunks.push(audio) });
    return { data: concatFloat32(chunks), sampleRate: tts.sampleRate };
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
