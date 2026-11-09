import { afterEach, describe, expect, it, vi } from 'vitest';
import { setSetting } from '../../core/settings';
import {
  KOKORO_VOICES_CACHE,
  POCKET_CACHE,
  TRANSFORMERS_CACHE,
  deleteModel,
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
    const { storage, buckets } = fakeCacheStorage({
      [TRANSFORMERS_CACHE]: ['https://huggingface.co/other-model/onnx/model.onnx', 'https://huggingface.co/onnx-community/embed-model/model.onnx'],
      [KOKORO_VOICES_CACHE]: [],
    });
    vi.stubGlobal('caches', storage);
    await setSetting('tts.model.kokoro.ready', false);
    await expect(isModelDownloaded('kokoro')).resolves.toBe(false);

    buckets[TRANSFORMERS_CACHE].push('https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model.onnx');
    await expect(isModelDownloaded('kokoro')).resolves.toBe(true);
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

  it('only removes Kokoro entries from the shared transformers cache', async () => {
    const keep = 'https://huggingface.co/other/model.onnx';
    const { storage, buckets } = fakeCacheStorage({
      [TRANSFORMERS_CACHE]: [keep, 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model_q8.onnx'],
      [KOKORO_VOICES_CACHE]: ['https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/voices/af_heart.bin'],
    });
    vi.stubGlobal('caches', storage);

    await deleteModel('kokoro');

    expect(buckets[TRANSFORMERS_CACHE]).toEqual([keep]);
    expect(buckets[KOKORO_VOICES_CACHE]).toBeUndefined();
  });

  it('reports download sizes per dtype', () => {
    expect(kokoroSizeMb('fp32')).toBe(320);
    expect(kokoroSizeMb('fp16')).toBe(170);
    expect(kokoroSizeMb('q8')).toBe(90);
  });
});
