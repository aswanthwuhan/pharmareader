import { afterEach, describe, expect, it, vi } from 'vitest';
import { setSetting } from '../../core/settings';
import {
  KOKORO_VOICES_CACHE,
  POCKET_CACHE,
  TRANSFORMERS_CACHE,
  deleteModel,
  hasModelFiles,
  isKokoroWeightsDownloaded,
  isModelDownloaded,
  kokoroSizeMb,
} from './models';

/** Minimal Cache Storage stand-in: enough for the bookkeeping helpers. */
function fakeCacheStorage(buckets: Record<string, string[]>): {
  storage: CacheStorage;
  buckets: Record<string, string[]>;
} {
  const state = { ...buckets };
  const storage = {
    has: async (name: string) => name in state,
    open: async (name: string) => ({
      keys: async () => (state[name] ?? []).map((url) => ({ url }) as Request),
      delete: async (request: Request) => {
        const url = String(request.url);
        state[name] = (state[name] ?? []).filter((entry) => entry !== url);
        return true;
      },
    }),
    delete: async (name: string) => {
      const existed = name in state;
      delete state[name];
      return existed;
    },
  };
  return { storage: storage as unknown as CacheStorage, buckets: state };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('models download bookkeeping', () => {
  it('reports the ready flag even when a cache cannot be read', async () => {
    await setSetting('tts.model.pocket.ready', false);
    vi.stubGlobal('caches', undefined);
    await expect(isModelDownloaded('pocket')).resolves.toBe(false);

    await setSetting('tts.model.pocket.ready', true);
    await expect(isModelDownloaded('pocket')).resolves.toBe(true);
    await setSetting('tts.model.pocket.ready', false);
  });

  it('detects Kokoro weights and ignores unrelated transformers models', async () => {
    const kokoro = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX';
    const { storage, buckets } = fakeCacheStorage({
      [TRANSFORMERS_CACHE]: [
        'https://huggingface.co/other-model/onnx/model.onnx',
        'https://huggingface.co/onnx-community/embed-model/model.onnx',
        `${kokoro}/config.json`,
        `${kokoro}/tokenizer.json`,
      ],
      [KOKORO_VOICES_CACHE]: [],
    });
    vi.stubGlobal('caches', storage);
    await setSetting('tts.model.kokoro.ready', false);
    // Tokenizer + config alone are not a model.
    await expect(isModelDownloaded('kokoro')).resolves.toBe(false);

    // The fp32 weights (the only build the web engine loads) complete it; the
    // unrelated models' own `model.onnx` must not count.
    buckets[TRANSFORMERS_CACHE].push(`${kokoro}/onnx/model.onnx`);
    await expect(isModelDownloaded('kokoro')).resolves.toBe(true);
  });

  it('counts only the fp32 weights as a Kokoro download', async () => {
    // The old default was q8, so an existing reader has the int8 weights on disk and
    // `ready` set. fp32 is the only build the web engine loads now: those files are not
    // that model, and claiming them made the first Play start a silent 320 MB download
    // (or fail offline). Cache Storage is the only place that knows the difference.
    const kokoro = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX';
    const { storage, buckets } = fakeCacheStorage({
      [TRANSFORMERS_CACHE]: [
        `${kokoro}/config.json`,
        `${kokoro}/tokenizer.json`,
        `${kokoro}/onnx/model_quantized.onnx`,
      ],
      [KOKORO_VOICES_CACHE]: [],
    });
    vi.stubGlobal('caches', storage);
    await setSetting('tts.model.kokoro.ready', true);

    await expect(isKokoroWeightsDownloaded()).resolves.toBe(false);
    // …and the leftover is still visible as something to delete.
    await expect(hasModelFiles('kokoro')).resolves.toBe(true);

    buckets[TRANSFORMERS_CACHE].push(`${kokoro}/onnx/model_fp16.onnx`);
    await expect(isKokoroWeightsDownloaded()).resolves.toBe(false);

    buckets[TRANSFORMERS_CACHE].push(`${kokoro}/onnx/model.onnx`);
    await expect(isKokoroWeightsDownloaded()).resolves.toBe(true);
    await setSetting('tts.model.kokoro.ready', false);
  });

  it('trusts the ready flag when Cache Storage is unreadable', async () => {
    // Private mode: the flag is the only signal, and only a successful fp32 load sets it.
    vi.stubGlobal('caches', undefined);
    await setSetting('tts.model.kokoro.ready', true);
    await expect(isKokoroWeightsDownloaded()).resolves.toBe(true);
    await setSetting('tts.model.kokoro.ready', false);
    await expect(isKokoroWeightsDownloaded()).resolves.toBe(false);
  });

  it('a partial Pocket download is not "downloaded"', async () => {
    // The real failure: an aborted download left bundle.json + tokenizer in the
    // bucket, the panel said "Ready", and Play then did nothing at all.
    const base = 'https://huggingface.co/vlapky/pocket-tts-onnx/resolve/main/onnx/english_2026-04';
    const { storage, buckets } = fakeCacheStorage({
      [POCKET_CACHE]: [`${base}/bundle.json`, `${base}/tokenizer.model`],
    });
    vi.stubGlobal('caches', storage);
    await setSetting('tts.model.pocket.ready', false);
    await expect(isModelDownloaded('pocket')).resolves.toBe(false);

    buckets[POCKET_CACHE].push(
      `${base}/text_conditioner_int8.onnx`,
      `${base}/flow_lm_main_int8.onnx`,
      `${base}/flow_lm_flow_int8.onnx`,
      `${base}/mimi_decoder_int8.onnx`
    );
    // Still missing voices.bin: the model cannot speak yet.
    await expect(isModelDownloaded('pocket')).resolves.toBe(false);

    buckets[POCKET_CACHE].push(`${base}/voices.bin`);
    await expect(isModelDownloaded('pocket')).resolves.toBe(true);
  });

  it('deletes a library-private bucket whole', async () => {
    const { storage, buckets } = fakeCacheStorage({
      [POCKET_CACHE]: ['https://huggingface.co/vlapky/pocket-tts-onnx/flow_lm_main.onnx', 'https://huggingface.co/vlapky/pocket-tts-onnx/voices.bin'],
    });
    vi.stubGlobal('caches', storage);
    await setSetting('tts.model.pocket.ready', true);

    await deleteModel('pocket');

    expect(buckets[POCKET_CACHE]).toBeUndefined();
    await expect(isModelDownloaded('pocket')).resolves.toBe(false);
  });

  it('removes every Kokoro weight variant from the shared transformers cache', async () => {
    const keep = 'https://huggingface.co/other/model.onnx';
    const kokoro = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/onnx';
    // The q8/fp16 files are retired from the app but a reader who downloaded them still
    // has them (~90–170 MB), so Delete must take them all, not just the fp32 model.
    const { storage, buckets } = fakeCacheStorage({
      [TRANSFORMERS_CACHE]: [
        keep,
        `${kokoro}/model.onnx`,
        `${kokoro}/model_fp16.onnx`,
        `${kokoro}/model_quantized.onnx`,
      ],
      [KOKORO_VOICES_CACHE]: [`${kokoro}/../voices/af_heart.bin`],
    });
    vi.stubGlobal('caches', storage);

    await expect(hasModelFiles('kokoro')).resolves.toBe(true);
    await deleteModel('kokoro');

    expect(buckets[TRANSFORMERS_CACHE]).toEqual([keep]);
    expect(buckets[KOKORO_VOICES_CACHE]).toBeUndefined();
    await expect(hasModelFiles('kokoro')).resolves.toBe(false);
  });

  it('reports the single fp32 download size', () => {
    // One web build only: the panel shows a number, not a precision menu.
    expect(kokoroSizeMb()).toBe(320);
    expect(kokoroSizeMb('fp32')).toBe(320);
  });

  it('throws when the storage refuses to delete the weights', async () => {
    // A cache whose delete() reports success but keeps the entries (seen when
    // the quota/policy layer refuses the removal).
    const state: Record<string, string[]> = {
      [POCKET_CACHE]: ['https://huggingface.co/vlapky/pocket-tts-onnx/flow_lm_main.onnx'],
    };
    const storage = {
      has: async (name: string) => name in state,
      open: async (name: string) => ({
        keys: async () => (state[name] ?? []).map((url) => ({ url }) as Request),
        delete: async () => true, // no-op: the entry stays
      }),
      delete: async () => true, // bucket "deleted" but still reachable
    } as unknown as CacheStorage;
    vi.stubGlobal('caches', storage);
    await setSetting('tts.model.pocket.ready', true);

    await expect(deleteModel('pocket')).rejects.toThrow('Could not delete the downloaded model files');
    // The flag must survive so the UI can still show the model as downloaded.
    await expect(isModelDownloaded('pocket')).resolves.toBe(true);
  });
});
