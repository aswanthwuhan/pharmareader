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
 *
 * Downloaded means *complete*: a bucket that merely holds the tokenizer is not a
 * usable model. Checking the whole file set is what stops the panel from
 * showing "Ready" after an aborted 127 MB download (the reader then played
 * nothing at all, with no error).
 */
import { getSetting, setSetting } from '../../core/settings';
export { POCKET_SIZE_MB, kokoroSizeMb } from './sizes';

export const POCKET_CACHE = 'pocket-tts-js-v1';
export const TRANSFORMERS_CACHE = 'transformers-cache';
export const KOKORO_VOICES_CACHE = 'kokoro-voices';

/**
 * Every file `pocket-tts-js` needs before it can speak: the 4 INT8 graphs, the
 * bundle + tokenizer, and `voices.bin` (52 MB, fetched by the first voice load —
 * `prepare()` warms it so that first Play is not a silent download).
 */
export const POCKET_FILES = [
  'bundle.json',
  'tokenizer.model',
  'text_conditioner_int8.onnx',
  'flow_lm_main_int8.onnx',
  'flow_lm_flow_int8.onnx',
  'mimi_decoder_int8.onnx',
  'voices.bin',
] as const;

export type NeuralModelId = 'pocket' | 'kokoro';

export interface NeuralModelInfo {
  label: string;
  caches: string[];
  /** Entries belonging to this model — used when deleting (the buckets may be shared). */
  match: (url: string) => boolean;
  /** True when the cached file names add up to a model that can actually speak. */
  complete: (files: string[]) => boolean;
}

export const NEURAL_MODELS: Record<NeuralModelId, NeuralModelInfo> = {
  pocket: {
    label: 'Pocket TTS (INT8)',
    caches: [POCKET_CACHE],
    match: () => true, // every entry in this bucket belongs to Pocket TTS
    complete: (files) => POCKET_FILES.every((name) => files.includes(name)),
  },
  kokoro: {
    label: 'Kokoro-82M',
    caches: [TRANSFORMERS_CACHE, KOKORO_VOICES_CACHE],
    match: (url) => url.includes('Kokoro-82M') || url.includes('/voices/'),
    // `model_quantized.onnx` for q8, `model.onnx`/`model_fp16.onnx` otherwise:
    // the dtype is user-selectable, so any single weights file will do.
    complete: (files) =>
      files.includes('config.json') &&
      files.includes('tokenizer.json') &&
      files.some((name) => /^model.*\.onnx$/.test(name)),
  },
};

/** Last path segment of a cache key, without the query string. */
export function fileName(url: string): string {
  const path = url.split('?')[0] ?? '';
  return path.slice(path.lastIndexOf('/') + 1);
}

/** True when `prepare()` has succeeded for this engine at least once. */
export async function isModelReadyFlag(id: NeuralModelId): Promise<boolean> {
  return getSetting<boolean>(`tts.model.${id}.ready`, false);
}

export async function setModelReady(id: NeuralModelId, ready = true): Promise<void> {
  await setSetting(`tts.model.${id}.ready`, ready);
}

/**
 * Cache keys that belong to this model (empty when Cache Storage is unavailable).
 * `transformers-cache` is shared, so only entries whose URL names this model are
 * counted — otherwise another transformers.js model's `model.onnx` would make
 * Kokoro look downloaded.
 */
async function cachedFileNames(id: NeuralModelId): Promise<string[]> {
  const info = NEURAL_MODELS[id];
  const names: string[] = [];
  if (typeof caches === 'undefined') return names;
  try {
    for (const name of info.caches) {
      if (!(await caches.has(name))) continue;
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        if (info.match(request.url)) names.push(fileName(request.url));
      }
    }
  } catch {
    // Cache Storage can throw in private mode — treat as "unknown/not downloaded".
  }
  return names;
}

/** Entries matching this model's `match()` (used for deletion + verification). */
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
    // As above.
  }
  return false;
}

/** True when the whole file set is cached (a partial download is not "downloaded"). */
export async function isModelComplete(id: NeuralModelId): Promise<boolean> {
  const files = await cachedFileNames(id);
  return files.length > 0 && NEURAL_MODELS[id].complete(files);
}

/** True when the weights are present and complete, or `prepare()` has succeeded. */
export async function isModelDownloaded(id: NeuralModelId): Promise<boolean> {
  return (await isModelReadyFlag(id)) || (await isModelComplete(id));
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
