/**
 * Messages between `kokoro.ts` (main thread) and `kokoro.worker.ts`.
 * Kokoro-82M needs 300+ MB of WASM memory, so it must never run on the UI
 * thread; the worker owns the model and the main thread only plays audio.
 */

export type KokoroDevice = 'webgpu' | 'wasm';
/**
 * The web build loads exactly one precision: fp32.
 *
 * The int8 export (`q8`, `model_quantized.onnx`) played garbled English on WASM and the
 * fp16 copy bought nothing but a second 170 MB download, so neither is offered any more.
 * The field stays in the init message because it is how the worker tells kokoro-js which
 * export to fetch.
 */
export type KokoroDtype = 'fp32';

export type KokoroRequest =
  | { type: 'init'; dtype: KokoroDtype; device: KokoroDevice }
  | { type: 'speak'; id: number; text: string; voice: string; speed: number }
  | { type: 'stop' };

export type KokoroResponse =
  | { type: 'progress'; fraction: number }
  | { type: 'ready'; voices: string[] }
  | { type: 'result'; id: number; audio: Float32Array; sampleRate: number }
  | { type: 'stopped'; id: number }
  | { type: 'error'; id?: number; message: string };
