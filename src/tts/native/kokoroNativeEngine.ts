/**
 * Kokoro-82M running natively on the Android phone through sherpa-onnx.
 *
 * `kokoroNativeEngine` implements the shared `TtsEngine` contract, so the
 * reader can swap it in wherever the WASM or server Kokoro engines are used.
 * Speech is sentence-pipelined: the next sentence is synthesised while the
 * current one plays, which hides most of the model latency on a phone CPU.
 */
import { getSetting, setSetting } from '../../core/settings';
import type { SpeakEvents, TtsEngine, TtsVoice } from '../../core/types';
import { planChunks } from '../neural/clauseChunk';
import { modelState, type KokoroModelKey } from './kokoroDownload';
import type { KokoroStage } from './kokoroFailure';
import { isKokoroNativeAvailable, Kokoro, type KokoroStatus } from './kokoroPlugin';

/** Voice used when nothing is configured: `af_heart` (sid 3). */
export const DEFAULT_KOKORO_SID = 3;
export const KOKORO_VOICE_SETTING = 'tts.voice.kokoro';
export const KOKORO_THREADS_SETTING = 'tts.kokoro.threads';
/**
 * Two threads: the model runs at roughly 0.75x real time on a mid-range phone without
 * keeping four cores busy. One thread is offered (coolest) but is usually slower than
 * real time, so it is not the default.
 */
export const DEFAULT_KOKORO_THREADS = 2;
/** Which build of the model the reader should use: the int8 graph on a new install. */
export const KOKORO_MODEL_SETTING = 'kokoro.native.model';
export const DEFAULT_KOKORO_MODEL: KokoroModelKey = 'int8';
/**
 * Set once the int8 model has been loaded successfully. The panel only offers to delete
 * the 334 MB fp32 files after this, so a user who downloads int8 but cannot load it (old
 * device, corrupt file) still has a working model.
 */
export const KOKORO_INT8_READY_SETTING = 'kokoro.native.int8Ready';

const MIN_SPEED = 0.5;
const MAX_SPEED = 2;
const MAX_THREADS = 8;

export interface KokoroMeasureResult {
  /** Synthesis time divided by audio duration; below 1 is faster than real time. */
  rtf: number;
  durationMs: number;
  elapsedMs: number;
  sampleRate: number;
}

interface SpeakOptions {
  voiceId?: string;
  rate: number;
}

/** English voices of kokoro-multi-lang-v1_0, for pickers shown before load. */
const FALLBACK_VOICES: TtsVoice[] = (
  [
  ['af_alloy', 'en-US'],
  ['af_aoede', 'en-US'],
  ['af_bella', 'en-US'],
  ['af_heart', 'en-US'],
  ['af_jessica', 'en-US'],
  ['af_kore', 'en-US'],
  ['af_nicole', 'en-US'],
  ['af_nova', 'en-US'],
  ['af_river', 'en-US'],
  ['af_sarah', 'en-US'],
  ['af_sky', 'en-US'],
  ['am_adam', 'en-US'],
  ['am_echo', 'en-US'],
  ['am_eric', 'en-US'],
  ['am_fenrir', 'en-US'],
  ['am_liam', 'en-US'],
  ['am_michael', 'en-US'],
  ['am_onyx', 'en-US'],
  ['am_puck', 'en-US'],
  ['am_santa', 'en-US'],
  ['bf_alice', 'en-GB'],
  ['bf_emma', 'en-GB'],
  ['bf_isabella', 'en-GB'],
  ['bf_lily', 'en-GB'],
  ['bm_daniel', 'en-GB'],
  ['bm_fable', 'en-GB'],
  ['bm_george', 'en-GB'],
  ['bm_lewis', 'en-GB'],
  ] as const
).map(([name, lang], index) => ({ id: String(index), name, lang }));

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clampSpeed(rate: number): number {
  return clampNumber(rate > 0 ? rate : 1, MIN_SPEED, MAX_SPEED);
}

/** Kokoro speaker ids are plain integers; the engine exposes them as strings. */
export function sidFromVoiceId(voiceId?: string): number {
  if (!voiceId) return DEFAULT_KOKORO_SID;
  const parsed = Number.parseInt(voiceId.trim(), 10);
  return Number.isFinite(parsed) ? clampNumber(parsed, 0, 103) : DEFAULT_KOKORO_SID;
}

async function threadsSetting(): Promise<number> {
  const saved = await getSetting<number>(KOKORO_THREADS_SETTING, DEFAULT_KOKORO_THREADS);
  const threads = Math.round(Number(saved));
  return Number.isFinite(threads) && threads > 0 ? clampNumber(threads, 1, MAX_THREADS) : DEFAULT_KOKORO_THREADS;
}

/** The saved model choice; an unknown or missing value means the int8 default. */
async function modelSetting(): Promise<KokoroModelKey> {
  try {
    const saved = await getSetting<string>(KOKORO_MODEL_SETTING, DEFAULT_KOKORO_MODEL);
    return saved === 'fp32' || saved === 'int8' ? saved : DEFAULT_KOKORO_MODEL;
  } catch {
    return DEFAULT_KOKORO_MODEL;
  }
}

/**
 * The build the plugin actually resolved: what the user asked for when it is installed,
 * otherwise the other build when that one is installed (an fp32-only install keeps
 * speaking fp32 until int8 has been downloaded).
 */
function resolvedModel(status: KokoroStatus, requested: KokoroModelKey): KokoroModelKey {
  const reported = status.model;
  return reported === 'int8' || reported === 'fp32' ? reported : requested;
}

/** Remember that int8 loaded once, which is what unlocks deleting the fp32 files. */
async function markInt8Ready(): Promise<void> {
  try {
    await setSetting(KOKORO_INT8_READY_SETTING, true);
  } catch {
    // The flag only gates a delete offer; failing to store it must not fail the load.
  }
}

async function voiceSetting(): Promise<string> {
  const saved = await getSetting<string>(KOKORO_VOICE_SETTING, String(DEFAULT_KOKORO_SID));
  return typeof saved === 'string' && saved.length > 0 ? saved : String(DEFAULT_KOKORO_SID);
}

/**
 * Base64 (the plugin emits no line breaks) to a WAV Blob.
 *
 * A sentence is 1-3 s of 24 kHz mono 16-bit audio, so ~50-150 KB of base64: `atob` plus a
 * typed-array fill costs well under a millisecond and keeps this synchronous, which the
 * sentence pipeline below relies on. `fetch('data:audio/wav;base64,…')` would add a
 * promise hop and a parser round-trip for no gain at this size.
 */
export function base64ToWavBlob(base64: string): Blob {
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new Error('Kokoro returned audio that could not be decoded.');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'audio/wav' });
}

function requireNative(): void {
  if (!isKokoroNativeAvailable()) {
    throw new Error('Kokoro on-device requires the Android app (native sherpa-onnx plugin).');
  }
}

interface CurrentAudio {
  audio: HTMLAudioElement;
  url: string;
  finish: () => void;
}

class KokoroNativeEngine implements TtsEngine {
  readonly id = 'kokoro' as const;
  readonly label = 'Kokoro (on-device)';
  readonly capabilities = {
    streaming: true,
    prerender: true,
    wordBoundaries: false,
    needsDownload: true,
  } as const;

  /** Bumped by stop(): any pipeline still awaiting audio exits quietly. */
  private generation = 0;
  private paused = false;
  private current: CurrentAudio | null = null;

  async isReady(): Promise<boolean> {
    if (!isKokoroNativeAvailable()) return false;
    try {
      return (await Kokoro.status({ model: await modelSetting() })).downloaded;
    } catch {
      return false;
    }
  }

  /** Download the model if needed, then load it into memory with the saved threads. */
  async prepare(
    onProgress?: (fraction: number) => void,
    onStage?: (stage: KokoroStage) => void
  ): Promise<void> {
    requireNative();
    onStage?.('status');
    const requested = await modelSetting();
    // The plugin answers `downloaded` for whichever build it can fall back to, so
    // an fp32 install reported int8 as present and "Download INT8" only reloaded
    // fp32. A build the user chose explicitly must itself be on disk; only the
    // unset default may lean on the other one.
    const chosen = (await getSetting<string | null>(KOKORO_MODEL_SETTING, null)) === requested;
    const present = (s: KokoroStatus): boolean =>
      chosen ? (modelState(s.models, requested)?.downloaded ?? s.downloaded) : s.downloaded;
    let status = await Kokoro.status({ model: requested });
    if (!present(status)) {
      onStage?.('download');
      const handle = await Kokoro.addListener('downloadProgress', (progress) => {
        const fraction = clampNumber(progress.fraction, 0, 1);
        // The archive is complete at 1, but the HTTP phase ends there; everything after it is
        // the bunzip2 + tar pass, which is where a weak phone spends minutes.
        if (fraction >= 1) onStage?.('unpack');
        onProgress?.(fraction);
      });
      try {
        await Kokoro.download({ model: requested });
      } finally {
        await handle.remove().catch(() => undefined);
      }
      onProgress?.(1);
      onStage?.('unpack');
      onStage?.('status');
      status = await Kokoro.status({ model: requested });
    }
    if (!present(status)) throw new Error('Kokoro model files are missing after the download.');

    const active = resolvedModel(status, requested);
    if (active === 'int8') await markInt8Ready();
    const threads = await threadsSetting();
    // status.threads is read from the loaded session, so an engine that is already warm in
    // this process (a second reader mount) is reused instead of reloading the model. The
    // loaded build is compared too: speaking int8 from an fp32 session is not a reuse.
    const loadedModel = status.loadedModel;
    if (status.loaded && status.threads === threads && (loadedModel === active || !loadedModel)) {
      return;
    }
    onStage?.('load');
    await Kokoro.load({ model: active, threads });
    if (active === 'int8') await markInt8Ready();
  }

  async listVoices(): Promise<TtsVoice[]> {
    if (!isKokoroNativeAvailable()) return FALLBACK_VOICES;
    try {
      const { voices } = await Kokoro.voices();
      const english = voices.filter((voice) => voice.english || voice.lang.startsWith('en'));
      const usable = english.length > 0 ? english : voices;
      if (usable.length === 0) return FALLBACK_VOICES;
      return usable.map((voice) => ({ id: String(voice.id), name: voice.name, lang: voice.lang }));
    } catch {
      return FALLBACK_VOICES;
    }
  }

  /** Synthesise one sentence to a WAV Blob (used by the cache/prerender layer). */
  async synthesize(text: string, opts: SpeakOptions): Promise<Blob> {
    requireNative();
    const trimmed = text.trim();
    if (!trimmed) throw new Error('Nothing to synthesise.');
    const result = await Kokoro.synthesize({
      text: trimmed,
      sid: sidFromVoiceId(opts.voiceId),
      speed: clampSpeed(opts.rate),
      threads: await threadsSetting(),
      model: await modelSetting(),
    });
    if (!result.wavBase64) {
      throw new Error(result.cancelled ? 'Kokoro synthesis was cancelled.' : 'Kokoro returned no audio.');
    }
    return base64ToWavBlob(result.wavBase64);
  }

  /** Speak the sentences in order, synthesising the next chunk during playback. */
  async speak(items: { id: string; text: string }[], opts: SpeakOptions, ev: SpeakEvents): Promise<void> {
    // Blank items would synthesise nothing and end the run early; drop them up front.
    const plan = planChunks(items);
    if (plan.length === 0) return;
    this.generation += 1;
    const generation = this.generation;
    this.paused = false;
    this.disposeCurrent();

    const alive = (): boolean => generation === this.generation;
    try {
      requireNative();
      const sid = sidFromVoiceId(opts.voiceId ?? (await voiceSetting()));
      const speed = clampSpeed(opts.rate);
      const threads = await threadsSetting();
      const model = await modelSetting();

      const synthesize = async (text: string): Promise<Blob | null> => {
        const trimmed = text.trim();
        if (!trimmed) return null;
        const result = await Kokoro.synthesize({ text: trimmed, sid, speed, threads, model });
        if (!alive() || result.cancelled || !result.wavBase64) return null;
        return base64ToWavBlob(result.wavBase64);
      };

      // Kick off chunk 0, then always keep one synthesis ahead of playback.
      let pending: Promise<Blob | null> = synthesize(plan[0].text);
      for (let index = 0; index < plan.length; index += 1) {
        const blob = await pending;
        if (!alive()) return;
        if (!blob) return; // cancelled: stop() already reset the generation

        const next = index + 1 < plan.length ? synthesize(plan[index + 1].text) : null;
        // The prefetch is only awaited after playback. If it rejects in the meantime the
        // browser reports an unhandled rejection (and a page-level error handler fires), so
        // mark it handled now; awaiting it below still rethrows.
        if (next) void next.catch(() => undefined);
        if (plan[index].first) ev.onStart?.(plan[index].itemId);
        await this.play(blob);
        if (!alive()) return;
        if (plan[index].last) ev.onEnd?.(plan[index].itemId);
        if (!next) return;
        pending = next;
      }
    } catch (err) {
      if (alive()) ev.onError?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (alive()) this.disposeCurrent();
    }
  }

  stop(): void {
    this.generation += 1;
    this.paused = false;
    this.disposeCurrent();
    if (isKokoroNativeAvailable()) void Kokoro.stop().catch(() => undefined);
  }

  pause(): void {
    this.paused = true;
    this.current?.audio.pause();
  }

  resume(): void {
    this.paused = false;
    const audio = this.current?.audio;
    if (!audio) return;
    void audio.play().catch(() => undefined);
  }

  /**
   * Remove one model build from disk and unload whatever is in memory. Without an argument
   * the plugin's default build (int8) is removed; the panel passes the explicit build, so
   * deleting the old fp32 files leaves an installed int8 model alone.
   */
  async deleteModel(model?: KokoroModelKey): Promise<void> {
    await this.release();
    if (!isKokoroNativeAvailable()) return;
    await Kokoro.deleteModel(model ? { model } : undefined);
  }

  /** Drop the loaded model (used after deleting the download). */
  async release(): Promise<void> {
    if (!isKokoroNativeAvailable()) return;
    await Kokoro.unload().catch(() => undefined);
  }

  /** Time one synthesis and return the real-time factor for the settings panel. */
  async measure(
    text: string,
    opts: SpeakOptions = { rate: 1 },
    onProgress?: (fraction: number) => void
  ): Promise<KokoroMeasureResult> {
    requireNative();
    if (!(await this.isReady())) await this.prepare(onProgress);
    const threads = await threadsSetting();
    const result = await Kokoro.synthesize({
      text: text.trim(),
      sid: sidFromVoiceId(opts.voiceId ?? (await voiceSetting())),
      speed: clampSpeed(opts.rate),
      threads,
      model: await modelSetting(),
    });
    if (result.cancelled || !result.wavBase64) throw new Error('Kokoro synthesis was cancelled.');
    return {
      rtf: result.rtf,
      durationMs: result.durationMs,
      elapsedMs: result.elapsedMs ?? Math.round(result.rtf * result.durationMs),
      sampleRate: result.sampleRate,
    };
  }

  /** Play one WAV Blob through an HTMLAudioElement, resolving on end or stop. */
  private play(blob: Blob): Promise<void> {
    return new Promise<void>((resolve) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        audio.onended = null;
        audio.onerror = null;
        try {
          audio.pause();
        } catch {
          /* the element may already be stopped */
        }
        audio.removeAttribute('src');
        URL.revokeObjectURL(url);
        if (this.current?.url === url) this.current = null;
        resolve();
      };
      this.current = { audio, url, finish };
      audio.onended = finish;
      audio.onerror = finish;
      if (this.paused) return; // stay silent until resume()
      const started = audio.play();
      if (started && typeof started.catch === 'function') started.catch(() => finish());
    });
  }

  private disposeCurrent(): void {
    const current = this.current;
    if (!current) return;
    this.current = null;
    current.finish();
  }
}

export const kokoroNativeEngine = new KokoroNativeEngine();
export type { KokoroNativeEngine };
