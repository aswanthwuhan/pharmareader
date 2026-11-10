/**
 * The on-device layout model: PP-DocLayout-L (RT-DETR, 23 region classes),
 * exported to ONNX with INT8 weights by `Ralutet/PP-DocLayout-L-onnx-int8`
 * (Apache-2.0; base model `PaddlePaddle/PP-DocLayout-L`).
 *
 * 32 MB is the smallest accurate PP-DocLayout ONNX: the V3 export that
 * OpenReader uses is 124.5 MB FP32 / 64.3 MB FP16 and takes 3× longer and 2.6×
 * the RAM on a phone (see `.tmp/layout/RESEARCH.md` for the comparison), and the
 * 4.7 MB PP-DocLayout-S confuses tables and charts on the very pages we care
 * about. The weights live in Cache Storage, so only the first use is online and
 * a later launch reads them back offline — same bookkeeping as the TTS engines
 * in `src/tts/neural/models.ts`.
 */
import { getSetting, setSetting } from '../../core/settings';
import { LABELS } from './engine';

export const LAYOUT_CACHE = 'pharma-reader-layout-v1';
const READY_KEY = 'import.layout.ready';

export const LAYOUT_MODEL = {
  label: 'PP-DocLayout-L',
  url: 'https://huggingface.co/Ralutet/PP-DocLayout-L-onnx-int8/resolve/main/pp-doclayout-l.onnx',
  /** Exact size of the file, for the progress bar and the "download stopped early" check. */
  bytes: 33_581_278,
  /** Everything is squashed to this square, matching the training transform (`keep_ratio: false`). */
  inputSize: 640,
  threshold: 0.5,
  /** Output class order, from the repo's `labels.json`. */
  labels: LABELS,
} as const;

async function cachedModel(): Promise<Response | null> {
  if (typeof caches === 'undefined') return null;
  try {
    const cache = await caches.open(LAYOUT_CACHE);
    return (await cache.match(LAYOUT_MODEL.url)) ?? null;
  } catch {
    // Private mode and quota errors: treat as "not downloaded".
    return null;
  }
}

/** True when the weights are cached (or a download reported success at least once). */
export async function isLayoutModelReady(): Promise<boolean> {
  if (await cachedModel()) return true;
  return getSetting<boolean>(READY_KEY, false);
}

/** The cached weights, or null when the user has not downloaded the model yet. */
export async function loadLayoutModelBytes(): Promise<ArrayBuffer | null> {
  const hit = await cachedModel();
  return hit ? hit.arrayBuffer() : null;
}

/** Fetch the weights once and keep them in Cache Storage. */
export async function downloadLayoutModel(onProgress?: (fraction: number) => void): Promise<void> {
  if (typeof caches === 'undefined') {
    throw new Error('This browser cannot store the layout model.');
  }

  const response = await fetch(LAYOUT_MODEL.url);
  if (!response.ok) throw new Error(`Could not download the layout model (HTTP ${response.status}).`);

  const total = Number(response.headers.get('content-length')) || LAYOUT_MODEL.bytes;
  const chunks: Uint8Array[] = [];
  let received = 0;

  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      // Stop at 99%: the file still has to be written to the cache.
      onProgress?.(Math.min(0.99, received / total));
    }
  } else {
    const buffer = new Uint8Array(await response.arrayBuffer());
    chunks.push(buffer);
    received = buffer.byteLength;
  }

  // A truncated file would fail deep inside ONNX Runtime with an unreadable
  // protobuf error and no way for the panel to recover, so reject it here.
  if (received < LAYOUT_MODEL.bytes * 0.95) {
    throw new Error('The download stopped early — check the connection and try again.');
  }

  const cache = await caches.open(LAYOUT_CACHE);
  await cache.put(LAYOUT_MODEL.url, new Response(new Blob(chunks as BlobPart[])));
  if (!(await cache.match(LAYOUT_MODEL.url))) {
    throw new Error('Could not store the layout model — the device may be out of space.');
  }

  await setSetting(READY_KEY, true);
  onProgress?.(1);
}

/** Delete the weights; imports fall back to the text-only layout until re-downloaded. */
export async function deleteLayoutModel(): Promise<void> {
  if (typeof caches !== 'undefined') {
    await caches.delete(LAYOUT_CACHE);
    if (await cachedModel()) throw new Error('Could not delete the downloaded model files');
  }
  await setSetting(READY_KEY, false);
}
