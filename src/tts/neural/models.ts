/**
 * Model download bookkeeping for the on-device engines.
 *
 * Both libraries persist their weights in Cache Storage, so the truth about a
 * download lives in these buckets (the names come from the libraries, keep in
 * sync when upgrading them):
 *   - pocket-tts-js: `pocket-tts-js-v1` (models, tokenizer, voices.bin)
 *   - kokoro-js / transformers.js: `transformers-cache` (ONNX weights + tokenizer)
 *     and `kokoro-voices` (the per-voice style tensors fetched by kokoro-js)
 *
 * Cache Storage is not always inspectable (private mode, quota errors), so a
 * successful `prepare()` also sets `tts.model.<id>.ready`. Either signal counts.
 * The caches are what makes the second launch offline: the libraries read them
 * instead of the network, so deleting them really frees the download — and
 * `deleteModel()` verifies that, because `cache.delete()` can silently fail.
 */
import { getSetting, setSetting } from '../../core/settings';

export const POCKET_CACHE = 'pocket-tts-js-v1';
export const TRANSFORMERS_CACHE = 'transformers-cache';
export const KOKORO_VOICES_CACHE = 'kokoro-voices';

/** Pocket TTS INT8 download (flow_lm + text conditioner + decoder), ~148 MB. */
export const POCKET_SIZE_MB = 148;

export type NeuralModelId = 'pocket' | 'kokoro';

export const NEURAL_MODELS: Record<
  NeuralModelId,
  { label: string; caches: string[]; match: (url: string) => boolean }
> = {
  pocket: {
    label: 'Pocket TTS (INT8)',
    caches: [POCKET_CACHE],
    match: () => true, // every entry in this bucket belongs to Pocket TTS
  },
  kokoro: {
    label: 'Kokoro-82M',
    caches: [TRANSFORMERS_CACHE, KOKORO_VOICES_CACHE],
    match: (url) => url.includes('Kokoro-82M') || url.includes('/voices/'),
  },
};

/** Approximate download size of the Kokoro weights per dtype. */
export function kokoroSizeMb(dtype: string): number {
  if (dtype === 'fp32') return 320;
  if (dtype === 'fp16') return 170;
  return 90; // q8 / q4
}

/** True when `prepare()` has succeeded for this engine at least once. */
export async function isModelReadyFlag(id: NeuralModelId): Promise<boolean> {
  return getSetting<boolean>(`tts.model.${id}.ready`, false);
}

export async function setModelReady(id: NeuralModelId, ready = true): Promise<void> {
  await setSetting(`tts.model.${id}.ready`, ready);
}

async function hasMatchingEntries(id: NeuralModelId): Promise<boolean> {
  const info = NEURAL_MODELS[id];
  if (typeof caches === 'undefined') return false;
  try {
    for (const name of info.caches) {
      if (!(await caches.has(name))) continue;
      const cache = await caches.open(name);
      const requests = await cache.keys();
      if (requests.some((request) => info.match(request.url))) return true;
    }
  } catch {
    // Cache Storage can throw in private mode — treat as "unknown/not downloaded".
  }
  return false;
}

/** True when the weights look present (cache bucket non-empty or ready flag set). */
export async function isModelDownloaded(id: NeuralModelId): Promise<boolean> {
  return (await isModelReadyFlag(id)) || hasMatchingEntries(id);
}

/**
 * Delete the downloaded weights; the next `prepare()` fetches them again.
 *
 * `transformers-cache` is shared with any other transformers.js model in the
 * app, so only matching entries are removed there; the library-private buckets
 * (`pocket-tts-js-v1`, `kokoro-voices`) are deleted whole.
 */
export async function deleteModel(id: NeuralModelId): Promise<void> {
  const info = NEURAL_MODELS[id];
  if (typeof caches !== 'undefined') {
    try {
      for (const name of info.caches) {
        if (!(await caches.has(name))) continue;
        const cache = await caches.open(name);
        const requests = await cache.keys();
        const ours = requests.filter((request) => info.match(request.url));
        if (ours.length === 0) continue;
        if (ours.length === requests.length) await caches.delete(name);
        else await Promise.all(ours.map((request) => cache.delete(request)));
      }
    } catch {
      // Private mode/quota: fall through and let the verification below decide.
    }
    if (await hasMatchingEntries(id)) {
      throw new Error('Could not delete the downloaded model files');
    }
  }
  await setModelReady(id, false);
}
