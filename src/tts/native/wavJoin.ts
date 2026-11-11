/**
 * Joining the WAV clips the native Kokoro plugin returns.
 *
 * The model's front end truncates at its token window (510 phoneme tokens), so
 * `kokoroNativeEngine.synthesize()` speaks a long sentence clause by clause and
 * the plugin answers with one complete WAV per call. The cache stores one file
 * per sentence, so those clips are decoded back to mono PCM, concatenated and
 * re-encoded.
 *
 * `neural/wav.ts` only has the encoder. The plugin writes a 44-byte header today
 * (`WavWriter.java`), but the RIFF chunk list is what the format defines, so this
 * walks the chunks instead of assuming an offset: anything that adds a `LIST` or
 * `JUNK` chunk would otherwise be read as silence or as a broken sample rate.
 */
import { concatFloat32, encodeWav } from '../neural/wav';

/** Mono samples in [-1, 1] plus the rate they were recorded at. */
export interface DecodedWav {
  pcm: Float32Array;
  sampleRate: number;
}

function chunkId(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}

/**
 * Decode a 16-bit PCM mono WAV. Anything else (stereo, 8/24/32-bit, a float or
 * compressed format, a truncated chunk) throws rather than being played as noise.
 */
export function decodeWav16(bytes: Uint8Array | ArrayBuffer): DecodedWav {
  const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (raw.byteLength < 12) throw new Error('Not a WAV file: too short for a RIFF header.');
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (chunkId(view, 0) !== 'RIFF' || chunkId(view, 8) !== 'WAVE') {
    throw new Error('Not a WAV file: no RIFF/WAVE header.');
  }

  let sampleRate = 0;
  let format = 0;
  let channels = 0;
  let bits = 0;
  let data: { offset: number; length: number } | null = null;

  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = chunkId(view, offset);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + size > view.byteLength) {
      throw new Error(`WAV chunk "${id}" claims ${size} bytes but the file ends before them.`);
    }
    if (id === 'fmt ') {
      if (size < 16) throw new Error('WAV fmt chunk is too short.');
      format = view.getUint16(start, true);
      channels = view.getUint16(start + 2, true);
      sampleRate = view.getUint32(start + 4, true);
      bits = view.getUint16(start + 14, true);
    } else if (id === 'data') {
      data = { offset: start, length: size };
      break;
    }
    offset = start + size + (size % 2); // chunks are word aligned
  }
  if (sampleRate === 0) throw new Error('WAV file has no fmt chunk.');
  if (data === null) throw new Error('WAV file has no data chunk.');
  // WavWriter builds the whole file in memory and states the true data size, so a data
  // chunk with no samples means the payload did not arrive. Failing the sentence is
  // better than caching a joined clip with a silent gap where a clause should be.
  if (data.length < 2) throw new Error('WAV data chunk holds no audio.');
  if (format !== 1) throw new Error('Only 16-bit PCM WAV audio can be joined.');
  if (channels !== 1) throw new Error('Only mono WAV audio can be joined.');
  if (bits !== 16) throw new Error('Only 16-bit PCM WAV audio can be joined.');

  const count = Math.floor(data.length / 2);
  const pcm = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const value = view.getInt16(data.offset + i * 2, true);
    // `encodeWav` uses the same scale and truncates toward zero, so a decoded level
    // re-encodes within one PCM step (worst measured: 1 level quieter, ~-90 dBFS).
    pcm[i] = value < 0 ? value / 0x8000 : value / 0x7fff;
  }
  return { pcm, sampleRate };
}

/**
 * One WAV holding every clip in order. A single clip is returned untouched: a
 * short sentence must keep the plugin's own bytes (and cost no re-encode).
 * Differing sample rates mean the clips cannot be played as one file, so that
 * throws instead of quietly resampling at the wrong pitch.
 */
export async function joinWavs(blobs: Blob[]): Promise<Blob> {
  if (blobs.length === 0) throw new Error('No audio to join.');
  if (blobs.length === 1) return blobs[0]!;
  const decoded = await Promise.all(blobs.map(async (blob) => decodeWav16(await blob.arrayBuffer())));
  const sampleRate = decoded[0]!.sampleRate;
  for (const part of decoded) {
    if (part.sampleRate !== sampleRate) {
      throw new Error(`Cannot join ${sampleRate} Hz audio with ${part.sampleRate} Hz audio.`);
    }
  }
  return encodeWav(concatFloat32(decoded.map((part) => part.pcm)), sampleRate);
}
