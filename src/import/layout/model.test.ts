import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../core/db';
import { createLayoutDetector } from './detector';
import { LAYOUT_CACHE, LAYOUT_MODEL, isLayoutModelReady } from './model';

/** Cache Storage with nothing in it, or with the weights. */
function stubCaches(model: Response | null): void {
  vi.stubGlobal('caches', {
    open: async (name: string) => ({
      match: async (url: string) => (name === LAYOUT_CACHE && url === LAYOUT_MODEL.url ? (model ?? undefined) : undefined),
    }),
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await db.delete();
  await db.open();
});

describe('isLayoutModelReady', () => {
  it('is true only while the weights are really in Cache Storage', async () => {
    stubCaches(new Response(new Uint8Array(8)));
    expect(await isLayoutModelReady()).toBe(true);
  });

  it('does not believe a "ready" flag that outlived the files', async () => {
    // A backup restored on a new phone carries the settings table, and the
    // browser may evict the cache: either way there is no model to run, and
    // "Ready" would hide the Download button while imports quietly fall back.
    await db.settings.put({ key: 'import.layout.ready', value: true });
    stubCaches(null);

    expect(await isLayoutModelReady()).toBe(false);
  });
});

describe('createLayoutDetector', () => {
  it('stops the worker when the model cannot be loaded', async () => {
    stubCaches(new Response(new Uint8Array(8)));
    const terminate = vi.fn();
    class FailingWorker extends EventTarget {
      terminate = terminate;
      postMessage(message: { type: string }): void {
        if (message.type !== 'load') return;
        queueMicrotask(() =>
          this.dispatchEvent(new MessageEvent('message', { data: { type: 'failed', message: 'bad protobuf' } })),
        );
      }
    }
    vi.stubGlobal('Worker', FailingWorker);

    await expect(createLayoutDetector()).rejects.toThrow('bad protobuf');
    // Otherwise every import with a corrupt download strands a worker holding the 32 MB file.
    expect(terminate).toHaveBeenCalledTimes(1);
  });
});
