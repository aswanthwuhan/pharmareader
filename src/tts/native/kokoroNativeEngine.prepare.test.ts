import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../core/db';
import { setSetting } from '../../core/settings';

// An fp32-only phone: the plugin falls back and calls the int8 request "downloaded".
const plugin = vi.hoisted(() => ({
  status: vi.fn(),
  download: vi.fn(async () => undefined),
  load: vi.fn(async () => undefined),
  addListener: vi.fn(async () => ({ remove: async () => undefined })),
}));
vi.mock('./kokoroPlugin', () => ({ isKokoroNativeAvailable: () => true, Kokoro: plugin }));

import { KOKORO_MODEL_SETTING, kokoroNativeEngine } from './kokoroNativeEngine';

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

describe('kokoroNativeEngine.prepare on an fp32-only install', () => {
  beforeEach(async () => {
    await db.settings.clear();
    plugin.status.mockReset().mockResolvedValue(fp32Only);
    plugin.download.mockClear();
  });

  it('downloads int8 when the user chose it, instead of reloading fp32', async () => {
    await setSetting(KOKORO_MODEL_SETTING, 'int8');
    plugin.status
      .mockResolvedValueOnce(fp32Only)
      .mockResolvedValue({ ...fp32Only, model: 'int8', models: [{ key: 'int8', downloaded: true }] });

    await kokoroNativeEngine.prepare();

    expect(plugin.download).toHaveBeenCalledWith({ model: 'int8' });
  });

  it('keeps speaking fp32 when no build was ever chosen', async () => {
    await kokoroNativeEngine.prepare();

    expect(plugin.download).not.toHaveBeenCalled();
    expect(plugin.load).toHaveBeenCalledWith(expect.objectContaining({ model: 'fp32' }));
  });
});
