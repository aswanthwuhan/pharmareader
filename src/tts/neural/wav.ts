/**
 * Minimal 16-bit mono WAV encoding/decoding helpers.
 *
 * The engines get raw Float32 PCM from the models (or MP3 from a server), and
 * the audio cache stores Blobs, so we need one tiny encoder here rather than a
 * dependency. Everything is little-endian per the RIFF spec.
 */

/** Join the streaming chunks of one utterance into a single buffer. */
export function concatFloat32(chunks: Float32Array[]): Float32Array {
  if (chunks.length === 1) return chunks[0];
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const out = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/**
 * Change speaking speed by resampling (pitch follows, like a tape machine).
 *
 * Pocket TTS has no speed input, so this is how `rate` reaches synthesised
 * audio: the same samples, sampled faster or slower. Kokoro takes speed as a
 * model input and does not need it.
 */
export function changeSpeed(samples: Float32Array, rate: number): Float32Array {
  if (!(rate > 0) || Math.abs(rate - 1) < 0.001 || samples.length === 0) return samples;
  const length = Math.max(1, Math.round(samples.length / rate));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const position = i * rate;
    const index = Math.floor(position);
    const fraction = position - index;
    const current = samples[index] ?? 0;
    const next = samples[index + 1] ?? current;
    out[i] = current + (next - current) * fraction;
  }
  return out;
}

/** Encode mono Float32 PCM in [-1, 1] as a 16-bit PCM WAV Blob. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const dataBytes = samples.length * 2;

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] < -1 ? -1 : samples[i] > 1 ? 1 : samples[i];
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Blob([header, pcm.buffer], { type: 'audio/wav' });
}

/** Duration of a WAV blob in ms, or 0 when the header is not parseable. */
export async function wavDurationMs(blob: Blob): Promise<number> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length < 44) return 0;
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (ascii(0) !== 'RIFF' || ascii(8) !== 'WAVE') return 0;

  // Walk the chunks instead of assuming our own 44-byte layout.
  let byteRate = 0;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = ascii(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ' && offset + 16 <= bytes.length) byteRate = view.getUint32(offset + 16, true);
    if (id === 'data') {
      if (!byteRate) return 0;
      return (size / byteRate) * 1000;
    }
    offset += 8 + size + (size % 2); // chunks are word aligned
  }
  return 0;
}

/**
 * Duration of any browser-decodable audio blob in ms (WAV headers first, then
 * `decodeAudioData` for the MP3 the Kokoro server returns). Falls back to 0.
 */
export async function audioDurationMs(blob: Blob): Promise<number> {
  const fromHeader = await wavDurationMs(blob);
  if (fromHeader > 0) return fromHeader;
  if (typeof AudioContext === 'undefined') return 0;
  const ctx = new AudioContext();
  try {
    const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
    return buffer.duration * 1000;
  } catch {
    return 0;
  } finally {
    void ctx.close();
  }
}
