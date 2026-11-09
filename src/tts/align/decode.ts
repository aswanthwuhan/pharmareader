/**
 * A synthesized clip → 16 kHz mono samples, the only input Whisper takes.
 *
 * The player hands us the same Blob it plays, which may be WAV (the on-device
 * engines) or whatever the browser's speech voice produced, so the browser's
 * decoder does the work. Decoding into an `OfflineAudioContext` that runs at
 * 16 kHz makes the browser resample for us; a plain `AudioContext` plus linear
 * resampling is the fallback for WebViews without the offline context.
 */
export const WHISPER_SAMPLE_RATE = 16000;

/** Down-mix to mono by averaging the channels (stereo clips are not expected). */
export function toMono(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels;
  const out = new Float32Array(buffer.length);
  if (channels === 0) return out;
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) + (data[i] ?? 0);
  }
  if (channels > 1) for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) / channels;
  return out;
}

/** Linear resampling; only used when the decoder cannot render at 16 kHz itself. */
export function resampleLinear(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0 || from <= 0 || to <= 0) return input;
  const length = Math.max(1, Math.round((input.length * to) / from));
  const out = new Float32Array(length);
  const step = from / to;
  for (let i = 0; i < length; i++) {
    const position = i * step;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const t = position - left;
    out[i] = (input[left] ?? 0) * (1 - t) + (input[right] ?? 0) * t;
  }
  return out;
}

interface OfflineCtor {
  new (channels: number, length: number, sampleRate: number): OfflineAudioContext;
}

interface PlainCtor {
  new (options?: { sampleRate?: number }): AudioContext;
}

function offlineContext(sampleRate: number): OfflineAudioContext | null {
  const scope = globalThis as unknown as {
    OfflineAudioContext?: OfflineCtor;
    webkitOfflineAudioContext?: OfflineCtor;
  };
  const Ctor = scope.OfflineAudioContext ?? scope.webkitOfflineAudioContext;
  if (!Ctor) return null;
  try {
    // One frame is enough: only `decodeAudioData` is used, and the browser
    // resamples the decoded clip to the context's rate.
    return new Ctor(1, 1, sampleRate);
  } catch {
    return null;
  }
}

async function decode(bytes: ArrayBuffer): Promise<AudioBuffer | null> {
  const offline = offlineContext(WHISPER_SAMPLE_RATE);
  if (offline) {
    try {
      return await offline.decodeAudioData(bytes.slice(0));
    } catch {
      /* Fall through to a plain context. */
    }
  }
  const scope = globalThis as unknown as { AudioContext?: PlainCtor; webkitAudioContext?: PlainCtor };
  const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
  if (!Ctor) return null;
  const context = new Ctor();
  try {
    return await context.decodeAudioData(bytes);
  } finally {
    void context.close?.().catch(() => undefined);
  }
}

/**
 * Decode `audio` to the samples Whisper expects. Returns an empty array when
 * the clip cannot be decoded here — the caller then keeps the estimate.
 */
export async function decodeToMono16k(audio: Blob): Promise<Float32Array> {
  if (audio.size === 0) return new Float32Array(0);
  const buffer = await decode(await audio.arrayBuffer());
  if (!buffer) return new Float32Array(0);
  const mono = toMono(buffer);
  return buffer.sampleRate === WHISPER_SAMPLE_RATE ? mono : resampleLinear(mono, buffer.sampleRate, WHISPER_SAMPLE_RATE);
}
