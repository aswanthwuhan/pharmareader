/**
 * Download bookkeeping for the on-device Whisper aligner.
 *
 * Same shape as the on-device voices (`src/tts/neural/models.ts`): the weights
 * live in transformers.js' shared Cache Storage bucket, a settings flag records
 * that a download finished, and both are checked so a reload does not offer to
 * download 42 MB again. It is a separate module because that registry is keyed
 * by the two voice engines only.
 */
import { getSetting, setSetting } from '../../core/settings';
import { fileName, TRANSFORMERS_CACHE } from '../neural/models';
import { WHISPER_MODEL_ID } from './whisperProtocol';

/** Set once the model has loaded at least once; the cache scan is the fallback. */
export const WHISPER_READY_SETTING = 'align.whisper.ready';

/**
 * iPhone opt-in for word timing (`align.whisper.ios`).
 *
 * Off by default there: the loaded model is another ~100 MB on a phone whose
 * Safari tab is already the scarcest thing the app owns. Everywhere else the
 * aligner is used whenever it is installed.
 */
export const WHISPER_IOS_SETTING = 'align.whisper.ios';

/**
 * Files transformers.js must have cached for the model to run offline. The two
 * graphs and the tokenizer are the model; `generation_config.json` carries the
 * cross-attention alignment heads, without which word timestamps cannot be
 * extracted at all.
 */
export const WHISPER_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'encoder_model_quantized.onnx',
  'decoder_model_merged_quantized.onnx',
];

/** Cache entries belong to this download when their URL names the repo. */
function matches(url: string): boolean {
  return url.includes(WHISPER_MODEL_ID);
}

type Caches = typeof globalThis.caches;

function cacheStore(): Caches | undefined {
  return typeof globalThis.caches === 'undefined' ? undefined : globalThis.caches;
}

/** True when Cache Storage is usable at all (private mode and some WebViews say no). */
export function hasModelCache(): boolean {
  return cacheStore() !== undefined;
}

async function cachedNames(): Promise<string[]> {
  const store = cacheStore();
  if (!store) return [];
  const names: string[] = [];
  try {
    if (!(await store.has(TRANSFORMERS_CACHE))) return [];
    const cache = await store.open(TRANSFORMERS_CACHE);
    for (const request of await cache.keys()) if (matches(request.url)) names.push(fileName(request.url));
  } catch {
    // Cache Storage can throw in private mode — treat as "not downloaded".
  }
  return names;
}

export async function isWhisperReadyFlag(): Promise<boolean> {
  return getSetting<boolean>(WHISPER_READY_SETTING, false);
}

export async function setWhisperReady(ready: boolean): Promise<void> {
  await setSetting(WHISPER_READY_SETTING, ready);
}

/** Every file of the model is cached (a partial download is not "downloaded"). */
export async function isWhisperComplete(): Promise<boolean> {
  const names = await cachedNames();
  return names.length > 0 && WHISPER_FILES.every((file) => names.includes(file));
}

export async function isWhisperDownloaded(): Promise<boolean> {
  return (await isWhisperReadyFlag()) || (await isWhisperComplete());
}

/**
 * Remove the cached weights; the next start/warm-up downloads them again.
 *
 * `transformers-cache` is shared with the voice models, so only this repo's
 * entries go; the cache bucket itself is kept.
 */
export async function deleteWhisperFiles(): Promise<void> {
  const store = cacheStore();
  if (store) {
    try {
      if (await store.has(TRANSFORMERS_CACHE)) {
        const cache = await store.open(TRANSFORMERS_CACHE);
        const requests = await cache.keys();
        const ours = requests.filter((request) => matches(request.url));
        await Promise.all(ours.map((request) => cache.delete(request)));
      }
    } catch {
      // Private mode/quota: the verification below reports what is left.
    }
    const left = await cachedNames();
    if (left.some((name) => WHISPER_FILES.includes(name))) {
      throw new Error('Could not delete the downloaded model files');
    }
  }
  await setWhisperReady(false);
}
