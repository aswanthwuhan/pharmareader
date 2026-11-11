/**
 * Kokoro-82M on device, inside a dedicated Web Worker (`kokoro.worker.ts`).
 *
 * Speed is a model input, so `rate` is passed to the model rather than applied
 * as playbackRate — the cached WAV then already has the right tempo. Sentence
 * N+1 is posted to the worker while N plays, so synthesis overlaps playback.
 */
import { getSetting, setSetting } from '../../core/settings';
import type { SpeakEvents, TtsEngine, TtsVoice } from '../../core/types';
import type { KokoroDevice, KokoroDtype, KokoroRequest, KokoroResponse } from './kokoroProtocol';
import { isKokoroWeightsDownloaded, setModelReady } from './models';
import { NEURAL_STAGES, neuralError } from './neuralError';
import { FloatPlayer } from './playback';
import { encodeWav } from './wav';

/**
 * Precision settings row written by the builds that still offered q8/fp16. Nothing reads
 * it as a choice any more: `retirePrecisionSetting` overwrites an old value once, so a
 * restored profile or a later build cannot pick 'q8' up as a live choice again.
 */
export const KOKORO_DTYPE_SETTING = 'tts.kokoro.dtype';
export const KOKORO_VOICE_SETTING = 'tts.kokoro.voice';
export const DEFAULT_KOKORO_VOICE = 'af_heart';

/**
 * The only precision the web build loads, on every device.
 *
 * It used to be q8 on WASM: `onnx/model_quantized.onnx` is the int8 export of the same
 * graph, and its waveform is not English — the emulator played "another language"
 * (garbled) while the fp32 weights were clean. fp16 saved ~150 MB of download and nothing
 * else, and two extra weight files were two extra ways to be wrong, so both are gone:
 * there is one model, ~320 MB.
 */
export const KOKORO_DTYPE: KokoroDtype = 'fp32';

/**
 * Overwrite a precision a previous build saved, once.
 *
 * The read costs one settings lookup per load and the write happens only while the row
 * still holds 'q8'/'fp16', so after the first load the old value is gone and nothing
 * reads it as a choice again.
 *
 * Best effort on purpose: nothing reads this row, so a store that refuses the write
 * (private mode, full quota) must not fail the load — the model on disk is here already,
 * and `init()` runs this before it starts the worker.
 */
async function retirePrecisionSetting(): Promise<void> {
  try {
    const stored = await getSetting<string>(KOKORO_DTYPE_SETTING, KOKORO_DTYPE);
    if (stored !== KOKORO_DTYPE) await setSetting(KOKORO_DTYPE_SETTING, KOKORO_DTYPE);
  } catch {
    // The old value stays in the store; it changes no behaviour in this build.
  }
}

/** Keep in sync with `VOICES` in kokoro-js (v1.2.1). */
const KOKORO_VOICES: TtsVoice[] = [
  'af_heart',
  'af_alloy',
  'af_aoede',
  'af_bella',
  'af_jessica',
  'af_kore',
  'af_nicole',
  'af_nova',
  'af_river',
  'af_sarah',
  'af_sky',
  'am_adam',
  'am_echo',
  'am_eric',
  'am_fenrir',
  'am_liam',
  'am_michael',
  'am_onyx',
  'am_puck',
  'am_santa',
  'bf_alice',
  'bf_emma',
  'bf_isabella',
  'bf_lily',
  'bm_daniel',
  'bm_fable',
  'bm_george',
  'bm_lewis',
].map((id) => ({
  id,
  name: prettyVoiceName(id),
  lang: id.charAt(0) === 'b' ? 'en-GB' : 'en-US',
}));

function prettyVoiceName(id: string): string {
  const name = id.slice(id.indexOf('_') + 1).replace(/_/g, ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

interface Pcm {
  data: Float32Array;
  sampleRate: number;
}

interface PendingRequest {
  resolve: (pcm: Pcm | null) => void;
  reject: (err: Error) => void;
}

class KokoroEngine implements TtsEngine {
  readonly id = 'kokoro' as const;
  readonly label = 'Kokoro (on device)';
  readonly capabilities = {
    streaming: true,
    prerender: true,
    wordBoundaries: false,
    needsDownload: true,
  } as const;

  private worker: Worker | null = null;
  private loading: Promise<void> | null = null;
  private pendingInit: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly player = new FloatPlayer();
  /**
   * One download, many watchers: the settings panel that started it, the reader that
   * asked for a voice meanwhile, and a remounted panel all subscribe here. A single
   * `onProgress` field meant the second caller silently got no progress ("the bar
   * stayed at 0% and then said download error").
   */
  private readonly progressListeners = new Set<(fraction: number) => void>();
  private voiceIds: string[] = KOKORO_VOICES.map((voice) => voice.id);
  private nextId = 1;
  private ready = false;
  private stopped = false;
  /** Bumped by `speak`/`stop` so a superseded utterance cannot resume playback. */
  private generation = 0;

  async isReady(): Promise<boolean> {
    if (this.ready) return true;
    // Same reload problem as Pocket: the cached model survives the reload, the worker
    // does not. Without this the reader fell back to the system voice after every reload.
    // Only the fp32 weights count: the retired q8/fp16 files are not the model this
    // engine runs, and claiming ready for them made the first Play start a silent download.
    return isKokoroWeightsDownloaded();
  }

  /**
   * The web build's cache identity is the voice *and* the weight precision: the same
   * sentence is different audio in another voice (and was, while it existed, in another
   * precision). Only fp32 is loaded now, but the `@fp32` suffix stays in the key — that is
   * how every clip already on disk is stored, so changing the format would throw them all
   * away for nothing.
   *
   * The voice is resolved exactly as `synthesize()` resolves it — `voice()` applies the
   * saved voice and the same fallback when the requested id is not a Kokoro voice — so
   * the key cannot name a voice the clip is not spoken in.
   */
  async cacheVariant(voiceId?: string): Promise<string> {
    const voice = await this.voice(voiceId);
    // `chunked`: clips cached before the worker split long sentences are missing their last words.
    // `3`: clips rendered on WebGPU before the phase wrap turn breathy partway through (or,
    // from 0.3.6, were voiced in choppy 10-word pieces).
    return `${voice}@${KOKORO_DTYPE}@chunked3`;
  }

  async prepare(onProgress?: (fraction: number) => void): Promise<void> {
    if (this.ready) {
      onProgress?.(1);
      return;
    }
    if (onProgress) this.progressListeners.add(onProgress);
    const pending = (this.loading ??= this.init());
    try {
      await pending;
    } catch (err) {
      if (onProgress) this.progressListeners.delete(onProgress);
      // Clear only our own attempt; a reset() may already have replaced it.
      if (this.loading === pending) this.loading = null;
      throw err;
    }
  }

  private async init(): Promise<void> {
    const device = await usableDevice();
    // Retire a precision saved when q8/fp16 could still be chosen. Doing it here, before
    // the download, is the one moment every reader passes through: leaving 'q8' behind
    // would make a later build read it as a live choice again. It cannot throw, so it
    // cannot cost a reader the model that is already on disk.
    await retirePrecisionSetting();

    try {
      const worker = this.ensureWorker();
      const done = new Promise<void>((resolve, reject) => {
        this.pendingInit = { resolve, reject };
      });
      worker.postMessage({ type: 'init', dtype: KOKORO_DTYPE, device } satisfies KokoroRequest);
      try {
        await done;
      } catch (err) {
        // Say which build failed: "no available backend found" is only actionable
        // together with the device the worker was asked for.
        throw neuralError(
          'kokoro',
          `${NEURAL_STAGES.model} (Kokoro-82M ${KOKORO_DTYPE}, ${device})`,
          err
        );
      }

      this.ready = true;
      this.emitProgress(1);
      // A hint for the next page load, not what makes the model run: the weights are in
      // Cache Storage and are in memory now, so a store that refuses the write must not
      // turn a finished load into a failed one.
      await setModelReady('kokoro', true).catch(() => undefined);
    } finally {
      // Do not retain the panels' progress callbacks once the download is over.
      this.progressListeners.clear();
    }
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
    return KOKORO_VOICES.map((voice) => ({ ...voice }));
  }

  async speak(
    items: { id: string; text: string }[],
    opts: { voiceId?: string; rate: number },
    ev: SpeakEvents
  ): Promise<void> {
    if (items.length === 0) return;
    this.stopped = false;
    const generation = ++this.generation;

    let voice: string;
    const rate = opts.rate > 0 ? opts.rate : 1;
    try {
      await this.prepare();
      voice = await this.voice(opts.voiceId);
    } catch (err) {
      if (!this.stopped) ev.onError?.(asError(err));
      return;
    }
    if (this.stopped || generation !== this.generation) return;

    await this.player.resume();
    if (this.stopped || generation !== this.generation) return;

    let next = this.request(items[0].text, voice, rate);
    next.catch(() => {});

    for (let i = 0; i < items.length; i++) {
      let pcm: Pcm | null;
      try {
        pcm = await next;
      } catch (err) {
        if (!this.stopped && generation === this.generation) ev.onError?.(asError(err));
        return;
      }
      if (!pcm || this.stopped || generation !== this.generation) return;

      if (i + 1 < items.length) {
        next = this.request(items[i + 1].text, voice, rate);
        next.catch(() => {});
      }

      ev.onStart?.(items[i].id);
      try {
        await this.player.play(pcm.data, pcm.sampleRate, 1);
      } catch (err) {
        if (!this.stopped && generation === this.generation) ev.onError?.(asError(err));
        return;
      }
      ev.onEnd?.(items[i].id);
      if (this.stopped || generation !== this.generation) return;
    }
  }

  async synthesize(text: string, opts: { voiceId?: string; rate: number }): Promise<Blob> {
    await this.prepare();
    const voice = await this.voice(opts.voiceId);
    const pcm = await this.request(text, voice, opts.rate > 0 ? opts.rate : 1);
    if (!pcm) throw new Error('Kokoro synthesis was stopped');
    return encodeWav(pcm.data, pcm.sampleRate);
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    this.player.stop();
    this.worker?.postMessage({ type: 'stop' } satisfies KokoroRequest);
    // The worker answers `stopped` only for the request it was running; the
    // requests queued behind it would otherwise keep their promises parked.
    this.rejectPending(new Error('Kokoro synthesis was stopped'));
  }

  pause(): void {
    this.player.pause();
  }

  resume(): void {
    this.player.resume();
  }

  /** Terminate the worker and free the model memory. */
  reset(): void {
    this.stopped = true;
    this.generation++;
    this.player.stop();
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.loading = null;
    this.progressListeners.clear();
    const init = this.pendingInit;
    this.pendingInit = null;
    init?.reject(new Error('Kokoro engine was reset'));
    // Nothing will answer these once the worker is gone.
    this.rejectPending(new Error('Kokoro engine was reset'));
    void this.player.dispose();
  }

  private rejectPending(err: Error): void {
    for (const request of this.pending.values()) request.reject(err);
    this.pending.clear();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    // Vite turns this into a bundled module worker.
    const worker = new Worker(new URL('./kokoro.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<KokoroResponse>) => this.receive(event.data);
    worker.onerror = (event) => this.fail(new Error(event.message || 'Kokoro worker error'));
    worker.onmessageerror = () => this.fail(new Error('Kokoro worker sent an unreadable message'));
    this.worker = worker;
    return worker;
  }

  /** Something is wrong with the worker: fail fast and allow a retry. */
  private fail(err: Error): void {
    this.ready = false;
    this.loading = null;
    this.pendingInit?.reject(err);
    this.pendingInit = null;
    this.rejectPending(err);
    this.worker?.terminate();
    this.worker = null;
  }

  private receive(msg: KokoroResponse): void {
    switch (msg.type) {
      case 'progress':
        this.emitProgress(msg.fraction);
        return;
      case 'ready':
        this.voiceIds = msg.voices.length > 0 ? msg.voices : this.voiceIds;
        this.pendingInit?.resolve();
        this.pendingInit = null;
        return;
      case 'result': {
        this.pending.get(msg.id)?.resolve({ data: msg.audio, sampleRate: msg.sampleRate });
        this.pending.delete(msg.id);
        return;
      }
      case 'stopped': {
        this.pending.get(msg.id)?.resolve(null);
        this.pending.delete(msg.id);
        return;
      }
      case 'error': {
        const err = new Error(msg.message);
        if (msg.id === undefined) {
          this.ready = false;
          this.loading = null;
          this.pendingInit?.reject(err);
          this.pendingInit = null;
          this.rejectPending(err);
        } else {
          this.pending.get(msg.id)?.reject(err);
          this.pending.delete(msg.id);
        }
        return;
      }
    }
  }

  private request(text: string, voice: string, speed: number): Promise<Pcm | null> {
    if (!this.ready) return Promise.reject(new Error('Kokoro model is not loaded'));
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<Pcm | null>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ type: 'speak', id, text, voice, speed } satisfies KokoroRequest);
    });
  }

  private async voice(requested?: string): Promise<string> {
    const saved = requested ?? (await getSetting<string>(KOKORO_VOICE_SETTING, DEFAULT_KOKORO_VOICE));
    if (this.voiceIds.includes(saved)) return saved;
    return this.voiceIds[0] ?? DEFAULT_KOKORO_VOICE;
  }
}

/** `Mozilla/5.0 (Linux; Android 16; sdk_gphone64_x86_64 Build/… ) AppleWebKit/537.36 … ; wv)`. */
const ANDROID_WEBVIEW_UA = /; wv\)/;

interface GpuNavigator {
  userAgent?: string;
  gpu?: { requestAdapter?: () => Promise<unknown> } | unknown;
}

/**
 * WebGPU only where the platform can actually hand out an adapter.
 *
 * Android System WebView (API 33+) exposes `navigator.gpu`, so a feature test passes on a
 * device that still has no working GPU backend: `requestAdapter()` resolves to `null`.
 * Claiming WebGPU there costs a full failed `from_pretrained()` — including the fp32
 * weights download — before the WASM retry in `kokoro.worker.ts` can start.
 * Measured on the emulator: `'gpu' in navigator` true, `requestAdapter()` null.
 */
export function detectDevice(nav: GpuNavigator | undefined = globalThis.navigator): KokoroDevice {
  if (!nav || typeof nav.userAgent !== 'string') return 'wasm';
  if (!('gpu' in nav)) return 'wasm';
  return ANDROID_WEBVIEW_UA.test(nav.userAgent) ? 'wasm' : 'webgpu';
}

/**
 * Device to actually load: `detectDevice()` only asks whether the API exists, so when it
 * says WebGPU the adapter is requested once before committing. One async call here saves a
 * wasted fp32 download and a failed session on devices that advertise but cannot deliver.
 */
export async function usableDevice(
  nav: GpuNavigator | undefined = globalThis.navigator
): Promise<KokoroDevice> {
  if (detectDevice(nav) !== 'webgpu') return 'wasm';
  const gpu = nav?.gpu as { requestAdapter?: () => Promise<unknown> } | undefined;
  if (typeof gpu?.requestAdapter !== 'function') return 'wasm';
  try {
    return (await gpu.requestAdapter()) === null ? 'wasm' : 'webgpu';
  } catch {
    return 'wasm';
  }
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export const kokoroEngine: TtsEngine = new KokoroEngine();

/** Persist the Kokoro voice choice (the settings panel calls this). */
export async function setKokoroVoice(voiceId: string): Promise<void> {
  await setSetting(KOKORO_VOICE_SETTING, voiceId);
}

/** Drop the loaded model (the panel calls this after deleting the download). */
export function resetKokoroEngine(): void {
  (kokoroEngine as KokoroEngine).reset();
}
