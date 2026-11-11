import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../core/db';
import { getSetting, setSetting } from '../../core/settings';

// Two kinds of phone: one that still has the fp32 model, and a v0.3.3 user whose fp32
// copy was deleted and whose int8 copy the plugin reports as `downloaded` (it falls back).
const plugin = vi.hoisted(() => ({
  status: vi.fn(),
  download: vi.fn(async () => undefined),
  load: vi.fn(async () => undefined),
  addListener: vi.fn(
    async (
      _event: string,
      _listener: (progress: { fraction: number }) => void
    ): Promise<{ remove: () => Promise<void> }> => ({ remove: async () => undefined })
  ),
}));
vi.mock('./kokoroPlugin', () => ({ isKokoroNativeAvailable: () => true, Kokoro: plugin }));

import {
  DEFAULT_KOKORO_THREADS,
  KOKORO_MODEL_SETTING,
  KOKORO_THREADS_SETTING,
  kokoroNativeEngine,
} from './kokoroNativeEngine';

const fp32Only = {
  downloaded: true,
  loaded: false,
  sizeBytes: 1,
  model: 'fp32',
  models: [
    { key: 'int8', downloaded: false },
    { key: 'fp32', downloaded: true },
  ],
};

const int8Only = {
  downloaded: true,
  loaded: false,
  sizeBytes: 1,
  model: 'int8',
  models: [
    { key: 'int8', downloaded: true },
    { key: 'fp32', downloaded: false },
  ],
};

const both = {
  downloaded: true,
  loaded: false,
  sizeBytes: 1,
  model: 'fp32',
  models: [
    { key: 'int8', downloaded: true },
    { key: 'fp32', downloaded: true },
  ],
};

describe('kokoroNativeEngine.prepare', () => {
  beforeEach(async () => {
    await db.settings.clear();
    plugin.status.mockReset().mockResolvedValue(fp32Only);
    plugin.download.mockClear();
    plugin.load.mockClear();
  });

  it('keeps speaking fp32 when no build was ever chosen', async () => {
    await kokoroNativeEngine.prepare();

    expect(plugin.download).not.toHaveBeenCalled();
    expect(plugin.load).toHaveBeenCalledWith(expect.objectContaining({ model: 'fp32' }));
  });

  it('downloads fp32 on an int8-only phone although the plugin calls it downloaded', async () => {
    plugin.status.mockResolvedValueOnce(int8Only).mockResolvedValue(both);

    await kokoroNativeEngine.prepare();

    expect(plugin.download).toHaveBeenCalledWith({ model: 'fp32' });
  });

  it('reports the download progress of the fp32 fetch instead of skipping it', async () => {
    plugin.status.mockResolvedValueOnce(int8Only).mockResolvedValue(both);
    // The listener is registered before the download starts; on the phone it emits one event
    // per chunk read. Emitting from the registration is enough to prove the wiring.
    plugin.addListener.mockImplementationOnce(
      async (_event: string, listener: (progress: { fraction: number }) => void) => {
        listener({ fraction: 0.4 });
        return { remove: async () => undefined };
      }
    );
    const progress: number[] = [];
    const stages: string[] = [];

    await kokoroNativeEngine.prepare(
      (fraction) => progress.push(fraction),
      (stage) => stages.push(stage)
    );

    expect(plugin.addListener).toHaveBeenCalledWith('downloadProgress', expect.any(Function));
    expect(progress[0]).toBeCloseTo(0.4);
    expect(progress.at(-1)).toBe(1);
    expect(stages).toEqual(['status', 'download', 'unpack', 'status', 'load']);
  });

  it('reads the int8 setting v0.3.3 wrote as fp32 and rewrites it', async () => {
    await setSetting(KOKORO_MODEL_SETTING, 'int8');

    await kokoroNativeEngine.prepare();

    expect(plugin.download).not.toHaveBeenCalled();
    expect(plugin.load).toHaveBeenCalledWith(expect.objectContaining({ model: 'fp32' }));
    // Rewritten, so the next mount — and the panel — agree without a second migration.
    expect(await getSetting(KOKORO_MODEL_SETTING, null)).toBe('fp32');
  });

  it('downloads nothing when the fp32 files are already on disk', async () => {
    plugin.status.mockResolvedValue(both);
    await setSetting(KOKORO_MODEL_SETTING, 'int8');

    await kokoroNativeEngine.prepare();

    expect(plugin.download).not.toHaveBeenCalled();
  });

  it('loads with the default two threads when nothing was saved', async () => {
    await kokoroNativeEngine.prepare();

    expect(DEFAULT_KOKORO_THREADS).toBe(2);
    expect(plugin.load).toHaveBeenCalledWith(expect.objectContaining({ threads: 2 }));
  });

  it('keeps the two threads v0.3.3 saved instead of rewriting them', async () => {
    await setSetting(KOKORO_THREADS_SETTING, 2);

    await kokoroNativeEngine.prepare();

    expect(plugin.load).toHaveBeenCalledWith(expect.objectContaining({ threads: 2 }));
    // v0.3.3's own value: read as it is, no migration mark, nothing written back.
    expect(await getSetting(KOKORO_THREADS_SETTING, null)).toBe(2);
  });

  it('keeps a thread count saved by an older build as it is', async () => {
    // 6 was one of the pre-0.3.3 options; v0.3.3 kept it and the panel shows "(saved)".
    await setSetting(KOKORO_THREADS_SETTING, 6);

    await kokoroNativeEngine.prepare();

    expect(plugin.load).toHaveBeenCalledWith(expect.objectContaining({ threads: 6 }));
    expect(await getSetting(KOKORO_THREADS_SETTING, null)).toBe(6);
  });
});
