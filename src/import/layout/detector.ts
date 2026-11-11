/**
 * Main-thread handle on the layout worker: the model bytes come from Cache
 * Storage once, and every page is a message away. `pdf.ts` creates one per
 * import and disposes it afterwards — a loaded model holds ~200 MB of WASM
 * memory, which is not worth keeping between imports on a phone.
 */
import type { LayoutBox } from './engine';
import { LAYOUT_MODEL, loadLayoutModelBytes } from './model';

export type LayoutRequest =
  | { type: 'load'; bytes: ArrayBuffer; inputSize: number; threshold: number }
  | { type: 'detect'; id: number; pixels: ArrayBuffer; pageWidth: number; pageHeight: number }
  | { type: 'dispose' };

export type LayoutReply =
  | { type: 'loaded'; ms: number }
  | { type: 'failed'; message: string }
  | { type: 'result'; id: number; boxes: LayoutBox[]; ms: number }
  | { type: 'error'; id: number; message: string };

/** A page takes seconds on a phone; a minute and a half means the worker is gone. */
export const DETECT_TIMEOUT_MS = 90_000;
/** Session creation is a few seconds; a minute means it is not coming. */
export const LOAD_TIMEOUT_MS = 60_000;

export interface PageLayoutDetector {
  /** Regions of one page, in PDF scale-1 page coordinates, reading order not included. */
  detect(pixels: Uint8ClampedArray, pageWidth: number, pageHeight: number): Promise<LayoutBox[]>;
  dispose(): void;
}

/** Null when the user has not downloaded the model — the caller uses the text layout. */
export async function createLayoutDetector(): Promise<PageLayoutDetector | null> {
  const bytes = await loadLayoutModelBytes();
  if (!bytes) return null;

  const worker = new Worker(new URL('./detector.worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, { resolve: (boxes: LayoutBox[]) => void; reject: (error: Error) => void }>();
  let nextId = 1;
  let failure: string | null = null;

  worker.addEventListener('message', (event: MessageEvent<LayoutReply>) => {
    const reply = event.data;

    if (reply.type === 'result') {
      pending.get(reply.id)?.resolve(reply.boxes);
      pending.delete(reply.id);
      return;
    }
    if (reply.type === 'error') {
      pending.get(reply.id)?.reject(new Error(reply.message));
      pending.delete(reply.id);
      return;
    }
    if (reply.type === 'failed') failure = reply.message;
  });

  worker.addEventListener('error', (event) => {
    failure = event.message || 'The layout worker stopped.';
    for (const entry of pending.values()) entry.reject(new Error(failure));
    pending.clear();
  });

  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  const loaded = new Promise<void>((resolve, reject) => {
    const onReply = (event: MessageEvent<LayoutReply>) => {
      const reply = event.data;
      if (reply.type === 'loaded') {
        worker.removeEventListener('message', onReply);
        resolve();
      } else if (reply.type === 'failed') {
        worker.removeEventListener('message', onReply);
        reject(new Error(reply.message));
      }
    };
    worker.addEventListener('message', onReply);
    worker.addEventListener('error', () => reject(new Error('The layout worker could not start')));
    // Loading is the longest window in which a phone can kill the worker, and a
    // worker killed there never answers either. A late reject is a no-op.
    loadTimer = setTimeout(() => reject(new Error('The layout model took too long to load')), LOAD_TIMEOUT_MS);
    worker.postMessage(
      { type: 'load', bytes, inputSize: LAYOUT_MODEL.inputSize, threshold: LAYOUT_MODEL.threshold } satisfies LayoutRequest,
      [bytes],
    );
  });
  try {
    await loaded;
  } catch (error) {
    // The caller gets no handle to dispose, so the worker has to go here.
    worker.terminate();
    throw error;
  } finally {
    clearTimeout(loadTimer);
  }

  let gone = false;

  return {
    async detect(pixels, pageWidth, pageHeight) {
      if (failure) throw new Error(failure);

      const id = nextId++;
      const boxes = new Promise<LayoutBox[]>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      // Transfer the pixels so a full-page buffer is not copied into the worker.
      const buffer = pixels.buffer as ArrayBuffer;
      worker.postMessage(
        { type: 'detect', id, pixels: buffer, pageWidth, pageHeight } satisfies LayoutRequest,
        [buffer],
      );
      // Android can kill a backgrounded worker without an `error` event, and the
      // reply then never comes: without a limit the import waits for ever.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const overdue = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          failure = 'The layout model stopped answering';
          gone = true;
          worker.terminate();
          reject(new Error(failure));
        }, DETECT_TIMEOUT_MS);
      });
      try {
        return await Promise.race([boxes, overdue]);
      } finally {
        clearTimeout(timer);
        pending.delete(id);
      }
    },
    dispose() {
      // Called again after a timeout already stopped the worker, and from `finally`.
      if (gone) return;
      gone = true;
      worker.postMessage({ type: 'dispose' } satisfies LayoutRequest);
      worker.terminate();
    },
  };
}
