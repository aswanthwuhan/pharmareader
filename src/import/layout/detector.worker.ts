/**
 * The layout model's inference loop, off the main thread: a page is ~300 ms of
 * WASM on a desktop and several times that on a phone, so it cannot run while
 * the user is scrolling.
 */
/// <reference lib="webworker" />
import { decodeDetections, dedupeBoxes, packInput } from './engine';
import { loadOrt, type OrtSession, type OrtTensor } from './ortRuntime';
import type { LayoutReply, LayoutRequest } from './detector';

const scope = self as unknown as DedicatedWorkerGlobalScope;

let session: OrtSession | null = null;
let boxesOutput = '';
let inputSize = 640;
let threshold = 0.5;

scope.onmessage = async (event: MessageEvent<LayoutRequest>) => {
  const message = event.data;

  if (message.type === 'load') {
    const started = performance.now();
    try {
      const ort = await loadOrt();
      inputSize = message.inputSize;
      threshold = message.threshold;
      session = await ort.InferenceSession.create(new Uint8Array(message.bytes), {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      // The export names its outputs `fetch_name_0` (boxes) and `fetch_name_1`
      // (count); take the first, which is the boxes in every export checked.
      boxesOutput = session.outputNames[0] ?? '';
      scope.postMessage({ type: 'loaded', ms: performance.now() - started } satisfies LayoutReply);
    } catch (error) {
      scope.postMessage({ type: 'failed', message: reason(error) } satisfies LayoutReply);
    }
    return;
  }

  if (message.type === 'detect') {
    const started = performance.now();
    try {
      if (!session) throw new Error('The layout model is not loaded.');
      const ort = await loadOrt();
      const image = new ort.Tensor('float32', packInput(new Uint8Array(message.pixels), inputSize), [
        1,
        3,
        inputSize,
        inputSize,
      ]);
      const shape = new ort.Tensor('float32', Float32Array.from([inputSize, inputSize]), [1, 2]);
      const scale = new ort.Tensor('float32', Float32Array.from([1, 1]), [1, 2]);

      // Feed by the model's own input names: the Paddle export calls them
      // `image`, `im_shape` and `scale_factor`, but that is the export's choice.
      const feeds: Record<string, OrtTensor> = {};
      for (const name of session.inputNames) {
        feeds[name] = /shape/i.test(name) ? shape : /scale/i.test(name) ? scale : image;
      }

      // Ask for the boxes output only. The export also carries a 300×200×200
      // mask head we never look at, and letting the runtime compute it costs
      // twice the time of the detection itself on WASM.
      const outputs = await session.run(feeds, boxesOutput ? [boxesOutput] : undefined);
      const boxes = outputs[boxesOutput] ?? Object.values(outputs)[0];
      if (!boxes) throw new Error('The layout model returned no detections.');

      const found = dedupeBoxes(
        decodeDetections(
          boxes.data as Float32Array,
          message.pageWidth,
          message.pageHeight,
          inputSize,
          threshold,
        ),
      );

      scope.postMessage(
        { type: 'result', id: message.id, boxes: found, ms: performance.now() - started } satisfies LayoutReply,
      );
    } catch (error) {
      scope.postMessage({ type: 'error', id: message.id, message: reason(error) } satisfies LayoutReply);
    }
    return;
  }

  scope.close();
};

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
