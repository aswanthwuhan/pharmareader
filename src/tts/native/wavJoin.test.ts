import { describe, expect, it } from 'vitest';
import { encodeWav } from '../neural/wav';
import { decodeWav16, joinWavs } from './wavJoin';

async function bytesOf(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await blob.arrayBuffer());
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

/**
 * Put an odd-sized JUNK chunk in front of the fmt chunk, the way a writer that
 * records list info does. The data chunk then starts past byte 44, which is exactly
 * the layout a parser that assumes a fixed header reads as samples.
 */
function withExtraChunk(wav: Uint8Array): Uint8Array<ArrayBuffer> {
  const payload = 3; // odd on purpose: the next chunk is word aligned
  const padded = payload + (payload % 2);
  const extra = 8 + padded;
  const out = new Uint8Array(wav.length + extra);
  out.set(wav.subarray(0, 12), 0);
  const view = new DataView(out.buffer);
  writeAscii(view, 12, 'JUNK');
  view.setUint32(16, payload, true);
  out.set(wav.subarray(12), 12 + extra);
  view.setUint32(4, out.length - 8, true);
  return out;
}

/** A 44-byte-header WAV holding raw PCM levels, the way `WavWriter.toBytes` lays them out. */
function wavOfInt16(samples: Int16Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(out.buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);
  out.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), 44);
  return out;
}

describe('decodeWav16', () => {
  it('decodes the 16-bit mono WAV encodeWav writes', async () => {
    const samples = new Float32Array([0.5, -0.5, 0.25, 0]);
    const decoded = decodeWav16(await bytesOf(encodeWav(samples, 24000)));

    expect(decoded.sampleRate).toBe(24000);
    expect(decoded.pcm.length).toBe(4);
    expect(decoded.pcm[0]).toBeCloseTo(0.5, 3);
    expect(decoded.pcm[1]).toBeCloseTo(-0.5, 3);
    expect(decoded.pcm[2]).toBeCloseTo(0.25, 3);
    expect(decoded.pcm[3]).toBe(0);
  });

  it('finds the data chunk when another chunk comes first', async () => {
    const wav = withExtraChunk(await bytesOf(encodeWav(new Float32Array([0.5, -0.25]), 22050)));
    const decoded = decodeWav16(wav);

    expect(decoded.sampleRate).toBe(22050);
    expect(decoded.pcm.length).toBe(2);
    expect(decoded.pcm[0]).toBeCloseTo(0.5, 3);
    expect(decoded.pcm[1]).toBeCloseTo(-0.25, 3);
  });

  it('throws on audio a 16-bit mono joiner cannot read', async () => {
    const bytes = await bytesOf(encodeWav(new Float32Array([0.1, 0.2]), 24000));
    // The channel count lives in the fmt chunk: make it stereo.
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(22, 2, true);
    expect(() => decodeWav16(bytes)).toThrow(/mono/);
    expect(() => decodeWav16(new Uint8Array([1, 2, 3]))).toThrow(/WAV/);
  });

  it('refuses a data chunk with no samples instead of joining silence', async () => {
    // WavWriter writes the true data size for the samples it holds, so an empty data
    // chunk means the payload did not arrive: a joined sentence must fail, not cache a gap.
    const bytes = wavOfInt16(new Int16Array(0), 24000);
    expect(() => decodeWav16(bytes)).toThrow(/no audio/);
  });

  it('refuses a data chunk the file is too short to hold', async () => {
    const bytes = wavOfInt16(new Int16Array([100, 200, 300, 400]), 24000);
    const truncated = bytes.subarray(0, bytes.length - 4); // the header still claims 8 bytes

    expect(() => decodeWav16(truncated)).toThrow(/ends before/);
  });

  it('rejects WAVE_FORMAT_EXTENSIBLE, which WavWriter never writes', async () => {
    const bytes = wavOfInt16(new Int16Array([100]), 24000);
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(20, 0xfffe, true);

    expect(() => decodeWav16(bytes)).toThrow(/16-bit PCM/);
  });

  it('round-trips every 16-bit level within one PCM step', async () => {
    // joinWavs decodes to float and re-encodes with encodeWav, which truncates where
    // WavWriter rounds: a positive level can come back one step quieter. Pin the bound so
    // a future scale change in either writer cannot silently deepen it (or start clipping).
    const levels = new Int16Array(65536);
    for (let i = 0; i < levels.length; i += 1) levels[i] = i - 0x8000;

    const decoded = decodeWav16(wavOfInt16(levels, 24000));
    const reencoded = new Int16Array((await bytesOf(encodeWav(decoded.pcm, 24000))).buffer.slice(44));

    expect(reencoded.length).toBe(levels.length);
    let worst = 0;
    for (let i = 0; i < levels.length; i += 1) {
      worst = Math.max(worst, Math.abs(reencoded[i]! - levels[i]!));
    }
    expect(worst).toBeLessThanOrEqual(1);
    // Full scale must not wrap: the loudest samples stay the loudest.
    expect(reencoded[0]).toBe(-0x8000);
    expect(reencoded[levels.length - 1]).toBe(0x7fff);
  });
});

describe('joinWavs', () => {
  it('joins clips in order into one WAV of the summed length', async () => {
    const first = encodeWav(new Float32Array([0.5, 0.5, 0.5]), 24000);
    const second = encodeWav(new Float32Array([-0.25, -0.25]), 24000);

    const joined = decodeWav16(await bytesOf(await joinWavs([first, second])));

    expect(joined.sampleRate).toBe(24000);
    expect(joined.pcm.length).toBe(5);
    expect(Array.from(joined.pcm).map((value) => Math.round(value * 100) / 100)).toEqual([
      0.5, 0.5, 0.5, -0.25, -0.25,
    ]);
  });

  it('returns a single clip untouched instead of re-encoding it', async () => {
    const wav = withExtraChunk(await bytesOf(encodeWav(new Float32Array([0.1, 0.2]), 24000)));
    const blob = new Blob([wav], { type: 'audio/wav' });

    expect(await joinWavs([blob])).toBe(blob);
  });

  it('throws when the clips were recorded at different sample rates', async () => {
    const first = encodeWav(new Float32Array([0.5]), 24000);
    const second = encodeWav(new Float32Array([0.5]), 22050);

    await expect(joinWavs([first, second])).rejects.toThrow('Cannot join 24000 Hz audio with 22050 Hz audio.');
  });
});
