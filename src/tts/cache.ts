/**
 * Audio cache contract: hash-addressed pre-rendered speech in IndexedDB.
 *
 * Key = SHA-256(text + engine + voice + rate). The voice field carries the engine's
 * cache variant when it has one: the voice the engine will really speak with (each
 * neural engine keeps its own choice in its own setting) and, for Kokoro, the weight
 * precision — see `cacheVoiceId`.
 * The text is the lexicon-expanded sentence, so a rule that changes how a sentence
 * is said changes its key and misses the old entry; a rule that does not touch the
 * sentence keeps it.
 */
import { db } from '../core/db';
import type { AudioCacheRecord } from '../core/types';

/** SHA-256 as lowercase hex. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) return toHex(new Uint8Array(await subtle.digest('SHA-256', bytes)));
  // jsdom (tests) and non-secure origins have no SubtleCrypto.
  return toHex(sha256(bytes));
}

export async function cacheKey(
  text: string,
  engineId: string,
  voiceId: string | undefined,
  rate: number,
): Promise<string> {
  // NUL separators: no field can contain one, so the tuple is unambiguous.
  return sha256Hex([engineId, voiceId ?? '', String(rate), text].join('\u0000'));
}

export async function getAudio(key: string): Promise<AudioCacheRecord | undefined> {
  return db.audioCache.get(key);
}

/** 300 MB: cheap phones and the PWA quota cannot afford more than this. */
export const DEFAULT_MAX_CACHE_BYTES = 300 * 1024 * 1024;

/**
 * Bytes currently stored, or `null` until the first `cacheSizeBytes()` call
 * fills it from the whole table. Every write path below keeps it in step, so
 * storing a clip never reads the table (a chapter pre-render would otherwise
 * pay one full scan per sentence).
 */
let audioBytes: number | null = null;

/** Forget the memoised total: for tests, and after the DB is deleted behind us. */
export function resetAudioSizeCache(): void {
  audioBytes = null;
}

/**
 * One write at a time. A playback prefetch and a pre-render can render the same
 * sentence together: each reads the row before the other stores it, and each
 * then adds the clip's bytes, so the total would count it twice and the next
 * prune would evict clips that fit. The first scan also has to be inside the
 * queue, otherwise a put's delta can land on top of a total another read just
 * filled from the table.
 */
let audioQueue: Promise<unknown> = Promise.resolve();

function queueAudio<T>(job: () => Promise<T>): Promise<T> {
  const run = audioQueue.then(job, job);
  // A failed write must not wedge every later one: the chain itself stays set.
  audioQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Sum the table into `audioBytes`; only called from inside the queue. */
async function loadAudioBytes(): Promise<number> {
  if (audioBytes === null) {
    let total = 0;
    for (const rec of await db.audioCache.toArray()) total += rec.audio.size ?? 0;
    audioBytes = total;
  }
  return audioBytes;
}

/**
 * Store a clip, then evict the oldest ones until the cache is back under budget.
 * Rows are keyed by content hash, so an edited sentence leaves the old row
 * behind forever unless something prunes it; this is that something.
 *
 * Returns the record through unchanged so callers can await it as before.
 */
export function putAudio(rec: AudioCacheRecord, maxBytes = DEFAULT_MAX_CACHE_BYTES): Promise<void> {
  return queueAudio(async () => {
    // A key can be rewritten (two callers rendered the same sentence at once), so
    // subtract what the row held before: one row read, never a table scan.
    const previous = audioBytes === null ? undefined : await getAudio(rec.key);
    await db.audioCache.put(rec);
    if (audioBytes === null) {
      // First write of the session: one scan gives an exact total, row included.
      await loadAudioBytes();
    } else {
      audioBytes = Math.max(0, audioBytes + (rec.audio.size ?? 0) - (previous?.audio.size ?? 0));
    }
    // Storage pressure must never fail playback: the clip is already stored.
    try {
      await pruneAudioNow(maxBytes);
    } catch {
      /* IndexedDB quota/lock errors are not a reason to stop the sentence */
    }
  });
}

/**
 * Evict least-recently-created clips until the cache is at or under `maxBytes`.
 * `createdAt` is indexed in the core schema, so this is one index walk.
 * Returns the number of bytes freed.
 */
export function pruneAudio(maxBytes = DEFAULT_MAX_CACHE_BYTES): Promise<number> {
  return queueAudio(() => pruneAudioNow(maxBytes));
}

async function pruneAudioNow(maxBytes: number): Promise<number> {
  const total = await loadAudioBytes();
  if (total <= maxBytes) return 0;

  let freed = 0;
  const doomed: string[] = [];
  for (const rec of await db.audioCache.orderBy('createdAt').toArray()) {
    if (total - freed <= maxBytes) break;
    doomed.push(rec.key);
    freed += rec.audio.size ?? 0;
  }
  if (doomed.length > 0) await db.audioCache.bulkDelete(doomed);
  audioBytes = Math.max(0, total - freed);
  return freed;
}

/** Drop cached audio for one engine, or everything when no engine is given. */
export function clearAudio(engineId?: string): Promise<void> {
  return queueAudio(async () => {
    if (engineId === undefined) {
      await db.audioCache.clear();
      audioBytes = 0;
      return;
    }
    // `engine` is not indexed (schema is owned by core), so filter the table.
    const rows = await db.audioCache.filter((r) => r.engine === engineId).toArray();
    await db.audioCache.bulkDelete(rows.map((r) => r.key));
    if (audioBytes !== null) {
      for (const row of rows) audioBytes -= row.audio.size ?? 0;
      audioBytes = Math.max(0, audioBytes);
    }
  });
}

export async function cacheSizeBytes(): Promise<number> {
  // Reading a known total is not a mutation; only the first fill must wait for
  // any put in flight, or it could scan a table and then be adjusted again.
  if (audioBytes !== null) return audioBytes;
  return queueAudio(loadAudioBytes);
}

/**
 * Duration of a RIFF/WAVE clip from its header, or 0 when the blob is not a
 * WAV we can parse (mp3/ogg encoders give no cheap duration). Used only to
 * fill `durationMs` for UI progress; it never blocks playback differently.
 */
export async function wavDurationMs(blob: Blob): Promise<number> {
  if (blob.size < 44) return 0;
  const buf = new Uint8Array(await blob.arrayBuffer());
  if (buf.length < 12) return 0;
  const tag = (o: number) => String.fromCharCode(buf[o]!, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return 0;

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let byteRate = 0;
  let dataSize = 0;
  for (let off = 12; off + 8 <= buf.length; ) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ' && size >= 12 && body + 12 <= buf.length) {
      byteRate = view.getUint32(body + 8, true);
    } else if (id === 'data' && size > 0) {
      dataSize = size;
    }
    off = body + size + (size & 1);
  }
  if (byteRate <= 0 || dataSize <= 0) return 0;
  return Math.round((dataSize / byteRate) * 1000);
}

/**
 * Where the speech sits inside a 16-bit PCM WAV: the first and last moment
 * louder than 2 % of the clip's peak. Kokoro pads a clip with ~0.3 s of silence
 * before and ~0.5 s after; a word clock that counts those as speech runs ahead
 * at the start of a sentence and behind at its end. Null for anything else.
 */
export async function wavSpeechMs(blob: Blob): Promise<{ startMs: number; endMs: number } | null> {
  if (blob.size < 44) return null;
  const buf = new Uint8Array(await blob.arrayBuffer());
  const tag = (o: number) => String.fromCharCode(buf[o]!, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let frameBytes = 0;
  let sampleRate = 0;
  let data = -1;
  let dataSize = 0;
  for (let off = 12; off + 8 <= buf.length; ) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= buf.length) {
      // PCM, 16 bits: the only form the on-device engines write.
      if (view.getUint16(body, true) !== 1 || view.getUint16(body + 14, true) !== 16) return null;
      sampleRate = view.getUint32(body + 4, true);
      frameBytes = view.getUint16(body + 12, true);
    } else if (id === 'data' && size > 0) {
      data = body;
      dataSize = Math.min(size, buf.length - body);
    }
    off = body + size + (size & 1);
  }
  if (data < 0 || sampleRate <= 0 || frameBytes < 2) return null;

  const frames = Math.floor(dataSize / frameBytes);
  const level = (frame: number) => Math.abs(view.getInt16(data + frame * frameBytes, true));
  let peak = 0;
  for (let i = 0; i < frames; i++) peak = Math.max(peak, level(i));
  const floor = peak * 0.02;
  if (floor <= 0) return null;
  let first = 0;
  while (first < frames && level(first) <= floor) first++;
  let last = frames - 1;
  while (last > first && level(last) <= floor) last--;
  return { startMs: (first / sampleRate) * 1000, endMs: ((last + 1) / sampleRate) * 1000 };
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

// ---------------------------------------------------------------------------
// Minimal SHA-256 (FIPS 180-4) for environments without WebCrypto.
// ---------------------------------------------------------------------------

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

function sha256(data: Uint8Array): Uint8Array {
  const padded = new Uint8Array((((data.length + 9) >> 6) + 1) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = data.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  view.setUint32(padded.length - 4, bits >>> 0);

  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15];
      const b = w[i - 2];
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  h.forEach((word, i) => outView.setUint32(i * 4, word));
  return out;
}
