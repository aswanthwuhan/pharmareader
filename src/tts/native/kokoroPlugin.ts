/**
 * Typed bridge to the native Capacitor plugin `Kokoro`
 * (android/app/src/main/java/com/aurapharmlab/pharmareader/kokoro/KokoroPlugin.java).
 *
 * The plugin runs Kokoro-82M through sherpa-onnx on the CPU with N threads, so
 * the whole model lives on the phone and no PC, server or WASM cross-origin
 * isolation is involved. Everything here is Android-only: on the web the calls
 * reject, so guard with `isKokoroNativeAvailable()` first.
 *
 * Two builds of the model can be installed side by side (int8 and fp32). Every call
 * takes an optional `model` key; when the named build is not installed the plugin
 * falls back to the other one if that is, so an existing fp32 install keeps working.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import type { KokoroModelKey, KokoroModelState } from './kokoroDownload';

export interface KokoroStatus {
  /** All required model files are present on disk. */
  downloaded: boolean;
  /** The OfflineTts instance is currently held in memory. */
  loaded: boolean;
  sizeBytes: number;
  freeBytes?: number;
  /** Bytes of a partial archive kept on disk; the next download resumes from here. */
  partialBytes?: number;
  /** Free storage the download needs (archive plus the unpacked model). */
  requiredBytes?: number;
  /** The active connection is mobile data, so the download should wait for Wi-Fi. */
  metered?: boolean;
  /** The model this status describes (the requested one, or the fallback that is installed). */
  model?: string;
  /** The model the caller asked for. */
  requested?: string;
  /** Build in memory, or '' when nothing is loaded. */
  loadedModel?: string;
  modelId?: string;
  /** Short label of the active build: "Lighter (int8)" / "Full precision". */
  modelLabel?: string;
  modelUrl?: string;
  archiveBytes?: number;
  extractedBytes?: number;
  attribution?: string;
  sampleRate?: number;
  threads?: number;
  /** ONNX Runtime execution provider actually in use ('cpu', 'xnnpack', 'nnapi'). */
  provider?: string;
  defaultSid?: number;
  voiceCount?: number;
  /** Both builds, installed or not — sizes here are the descriptors'. */
  models?: KokoroModelState[];
}

export interface KokoroDownloadProgress {
  /** 0..1, coalesced by the plugin to whole percent steps. */
  fraction: number;
  bytes?: number;
  totalBytes?: number;
  /** Which model the download belongs to. */
  model?: string;
}

export interface KokoroVoice {
  id: number;
  name: string;
  lang: string;
  english: boolean;
}

export interface KokoroLoadResult {
  loaded: boolean;
  threads: number;
  provider?: string;
  sampleRate: number;
  voiceCount: number;
  /** The build that is actually in memory after the call. */
  model?: string;
}

export interface KokoroDownloadResult {
  downloaded: boolean;
  sizeBytes: number;
  model?: string;
}

export interface KokoroSynthesizeResult {
  durationMs: number;
  sampleRate: number;
  /** Real-time factor of this synthesis (elapsed / audio duration). */
  rtf: number;
  elapsedMs?: number;
  bytes?: number;
  /**
   * Little-endian PCM16 mono WAV, base64 (no wrap) — for building a Blob.
   * This is the only copy of the audio: the plugin does not write a file.
   */
  wavBase64?: string;
  /** Set when a concurrent `stop()` cut the synthesis short. */
  cancelled?: boolean;
  /** The build that produced this audio. */
  model?: string;
}

export interface KokoroModelOptions {
  /** `int8` (default, cooler) or `fp32`. Unknown or missing means the plugin default. */
  model?: KokoroModelKey;
}

export interface KokoroPluginApi {
  status(options?: KokoroModelOptions): Promise<KokoroStatus>;
  download(options?: KokoroModelOptions): Promise<KokoroDownloadResult>;
  deleteModel(options?: KokoroModelOptions): Promise<KokoroDownloadResult>;
  load(
    options?: KokoroModelOptions & { threads?: number; debug?: boolean }
  ): Promise<KokoroLoadResult>;
  unload(): Promise<{ loaded: boolean }>;
  voices(): Promise<{ voices: KokoroVoice[]; defaultSid: number }>;
  synthesize(
    options: KokoroModelOptions & {
      text: string;
      sid?: number;
      speed?: number;
      threads?: number;
    }
  ): Promise<KokoroSynthesizeResult>;
  stop(): Promise<{ stopped: boolean }>;
  addListener(
    eventName: 'downloadProgress',
    listener: (progress: KokoroDownloadProgress) => void
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}

export const Kokoro = registerPlugin<KokoroPluginApi>('Kokoro');

/** The native engine only exists in the Android build (Capacitor platform). */
export function isKokoroNativeAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}
