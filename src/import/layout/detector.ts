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
    worker.addEventListener('error', () => reject(new Error('The layout worker could not start.')));
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
  }

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
      try {
        return await boxes;
      } finally {
        pending.delete(id);
      }
    },
    dispose() {
      worker.postMessage({ type: 'dispose' } satisfies LayoutRequest);
      worker.terminate();
    },
  };
}
