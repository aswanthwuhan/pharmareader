/**
 * Kokoro served by a local OpenAI-compatible TTS server (kokoro-fastapi,
 * `docker run … ghcr.io/remsky/kokoro-fastapi-cpu`). Nothing is downloaded:
 * the model lives next to the server, so this engine is the cheap option for
 * phones that cannot hold a 148 MB model.
 */
import { getSetting } from '../../core/settings';
import type { SpeakEvents, TtsEngine, TtsVoice } from '../../core/types';
import { ElementPlayer } from './playback';

export const SERVER_URL_SETTING = 'tts.kokoroServer.url';
export const DEFAULT_SERVER_URL = 'http://localhost:8880';
const REQUEST_TIMEOUT_MS = 2000;

interface SpeakOptions {
  voiceId?: string;
  rate: number;
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

async function baseUrl(): Promise<string> {
  const saved = await getSetting<string>(SERVER_URL_SETTING, DEFAULT_SERVER_URL);
  return normalizeUrl(saved) || DEFAULT_SERVER_URL;
}

/** Resolve after `ms`, aborting `fetch` — used for the reachability probe. */
async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** `GET /v1/audio/voices`, tolerating both `["af_heart"]` and `{"voices":[…]}`. */
export async function fetchVoices(base: string, signal?: AbortSignal): Promise<string[]> {
  const res = await fetch(`${normalizeUrl(base)}/v1/audio/voices`, { signal });
  if (!res.ok) throw new Error(`Kokoro server responded ${res.status}`);
  const data: unknown = await res.json();
  const list = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { voices?: unknown }).voices)
      ? (data as { voices: unknown[] }).voices
      : [];
  return list.filter((voice): voice is string => typeof voice === 'string' && voice.length > 0);
}

/** Cheap health probe: the voices endpoint, or the root, within 2s. */
export async function isServerReachable(base: string): Promise<boolean> {
  const root = normalizeUrl(base);
  try {
    return await withTimeout(REQUEST_TIMEOUT_MS, async (signal) => {
      const res = await fetch(`${root}/v1/audio/voices`, { signal });
      return res.ok;
    });
  } catch {
    /* fall through to the root probe */
  }
  try {
    return await withTimeout(REQUEST_TIMEOUT_MS, async (signal) => {
      const res = await fetch(root, { signal });
      return res.ok;
    });
  } catch {
    return false;
  }
}

class KokoroServerEngine implements TtsEngine {
  readonly id = 'kokoro-server' as const;
  readonly label = 'Kokoro server';
  readonly capabilities = {
    streaming: true,
    prerender: true,
    wordBoundaries: false,
    needsDownload: false,
  } as const;

  private readonly player = new ElementPlayer();
  private voices: string[] = ['af_heart'];
  private stopped = false;
  private controller: AbortController | null = null;

  async isReady(): Promise<boolean> {
    return isServerReachable(await baseUrl());
  }

  async prepare(onProgress?: (fraction: number) => void): Promise<void> {
    const base = await baseUrl();
    if (!(await isServerReachable(base))) {
      throw new Error(`Kokoro server is not reachable at ${base}`);
    }
    this.voices = await fetchVoices(base).catch(() => ['af_heart']);
    onProgress?.(1);
  }

  async listVoices(): Promise<TtsVoice[]> {
    const base = await baseUrl();
    this.voices = await fetchVoices(base).catch(() => this.voices);
    if (this.voices.length === 0) this.voices = ['af_heart'];
    return this.voices.map((id) => ({ id, name: prettyName(id), lang: id.startsWith('bf_') || id.startsWith('bm_') ? 'en-GB' : 'en-US' }));
  }

  async speak(
    items: { id: string; text: string }[],
    opts: SpeakOptions,
    ev: SpeakEvents
  ): Promise<void> {
    if (items.length === 0) return;
    this.stopped = false;
    const voice = opts.voiceId ?? this.voices[0] ?? 'af_heart';
    const speed = opts.rate > 0 ? opts.rate : 1;
    await this.player.resume();

    let next = this.speech(items[0].text, voice, speed);
    next.catch(() => {});

    for (let i = 0; i < items.length; i++) {
      let blob: Blob | null;
      try {
        blob = await next;
      } catch (err) {
        if (!this.stopped) ev.onError?.(asError(err));
        return;
      }
      if (!blob || this.stopped) return;

      if (i + 1 < items.length) {
        next = this.speech(items[i + 1].text, voice, speed);
        next.catch(() => {});
      }

      ev.onStart?.(items[i].id);
      await this.player.play(blob);
      ev.onEnd?.(items[i].id);
      if (this.stopped) return;
    }
  }

  async synthesize(text: string, opts: SpeakOptions): Promise<Blob> {
    const voice = opts.voiceId ?? this.voices[0] ?? 'af_heart';
    const blob = await this.speech(text, voice, opts.rate > 0 ? opts.rate : 1);
    if (!blob) throw new Error('Kokoro server request was stopped');
    return blob;
  }

  stop(): void {
    this.stopped = true;
    this.controller?.abort();
    this.controller = null;
    this.player.stop();
  }

  pause(): void {
    this.player.pause();
  }

  resume(): void {
    this.player.resume();
  }

  /** One sentence: POST the OpenAI speech body, return MP3 (null when aborted). */
  private async speech(text: string, voice: string, speed: number): Promise<Blob | null> {
    const base = await baseUrl();
    const controller = new AbortController();
    this.controller = controller;
    try {
      const res = await fetch(`${base}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: 'kokoro',
          input: text,
          voice,
          response_format: 'mp3',
          speed,
        }),
      });
      if (!res.ok) throw new Error(`Kokoro server responded ${res.status} ${res.statusText}`);
      return await res.blob();
    } catch (err) {
      if (this.stopped && isAbort(err)) return null;
      throw err;
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }
}

function prettyName(id: string): string {
  const name = id.slice(id.indexOf('_') + 1).replace(/_/g, ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export const kokoroServerEngine: TtsEngine = new KokoroServerEngine();
