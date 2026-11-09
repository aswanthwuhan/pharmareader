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
import { isModelDownloaded, setModelReady } from './models';
import { NEURAL_STAGES, neuralError } from './neuralError';
import { FloatPlayer } from './playback';
import { encodeWav } from './wav';

export const KOKORO_DTYPE_SETTING = 'tts.kokoro.dtype';
export const KOKORO_VOICE_SETTING = 'tts.kokoro.voice';
export const DEFAULT_KOKORO_VOICE = 'af_heart';

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
  private onProgress: ((fraction: number) => void) | undefined;
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
    return isModelDownloaded('kokoro');
  }

  async prepare(onProgress?: (fraction: number) => void): Promise<void> {
    if (this.ready) return;
    const pending = (this.loading ??= this.init(onProgress));
    try {
      await pending;
    } catch (err) {
      // Clear only our own attempt; a reset() may already have replaced it.
      if (this.loading === pending) this.loading = null;
      throw err;
    }
  }

  private async init(onProgress?: (fraction: number) => void): Promise<void> {
    this.onProgress = onProgress;
    const device = detectDevice();
    // WebGPU wants fp32 weights; WASM on phones is fastest with q8.
    const fallback: KokoroDtype = device === 'webgpu' ? 'fp32' : 'q8';
    const dtype = await getSetting<KokoroDtype>(KOKORO_DTYPE_SETTING, fallback);

    try {
      const worker = this.ensureWorker();
      const done = new Promise<void>((resolve, reject) => {
        this.pendingInit = { resolve, reject };
      });
      worker.postMessage({ type: 'init', dtype, device } satisfies KokoroRequest);
      try {
        await done;
      } catch (err) {
        // Say which build failed: "no available backend found" is only actionable
        // together with the device/dtype the worker was asked for.
        throw neuralError(
          'kokoro',
          `${NEURAL_STAGES.model} (Kokoro-82M ${dtype}, ${device})`,
          err
        );
      }

      this.ready = true;
      onProgress?.(1);
      await setModelReady('kokoro', true);
    } finally {
      // Do not retain the panel's progress callback once the download is over.
      this.onProgress = undefined;
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
        this.onProgress?.(msg.fraction);
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

function detectDevice(): KokoroDevice {
  return typeof navigator !== 'undefined' && 'gpu' in navigator ? 'webgpu' : 'wasm';
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
