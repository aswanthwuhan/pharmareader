/**
 * Typed bridge to the native Capacitor plugin `Kokoro`
 * (android/app/src/main/java/com/aurapharmlab/pharmareader/kokoro/KokoroPlugin.java).
 *
 * The plugin runs Kokoro-82M through sherpa-onnx on the CPU with N threads, so
 * the whole model lives on the phone and no PC, server or WASM cross-origin
 * isolation is involved. Everything here is Android-only: on the web the calls
 * reject, so guard with `isKokoroNativeAvailable()` first.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

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
  /** The active connection is mobile data, so the 334 MB download should wait for Wi-Fi. */
  metered?: boolean;
  modelId?: string;
  modelUrl?: string;
  archiveBytes?: number;
  attribution?: string;
  sampleRate?: number;
  threads?: number;
  /** ONNX Runtime execution provider actually in use ('cpu', 'xnnpack', 'nnapi'). */
  provider?: string;
  defaultSid?: number;
  voiceCount?: number;
}

export interface KokoroDownloadProgress {
  /** 0..1, coalesced by the plugin to whole percent steps. */
  fraction: number;
  bytes?: number;
  totalBytes?: number;
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
}

export interface KokoroDownloadResult {
  downloaded: boolean;
  sizeBytes: number;
}

export interface KokoroSynthesizeResult {
  /** Path of the 16-bit WAV in the app cache directory. */
  path: string;
  durationMs: number;
  sampleRate: number;
  /** Real-time factor of this synthesis (elapsed / audio duration). */
  rtf: number;
  elapsedMs?: number;
  bytes?: number;
  /** Little-endian PCM16 mono WAV, base64 (no wrap) — for building a Blob. */
  wavBase64?: string;
  /** Set when a concurrent `stop()` cut the synthesis short. */
  cancelled?: boolean;
}

export interface KokoroPluginApi {
  status(): Promise<KokoroStatus>;
  download(): Promise<KokoroDownloadResult>;
  deleteModel(): Promise<KokoroDownloadResult>;
  load(options?: { threads?: number; debug?: boolean }): Promise<KokoroLoadResult>;
  unload(): Promise<{ loaded: boolean }>;
  voices(): Promise<{ voices: KokoroVoice[]; defaultSid: number }>;
  synthesize(options: { text: string; sid?: number; speed?: number; threads?: number }): Promise<KokoroSynthesizeResult>;
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
