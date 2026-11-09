/**
 * Messages between `kokoro.ts` (main thread) and `kokoro.worker.ts`.
 * Kokoro-82M needs 300+ MB of WASM memory, so it must never run on the UI
 * thread; the worker owns the model and the main thread only plays audio.
 */

export type KokoroDevice = 'webgpu' | 'wasm';
export type KokoroDtype = 'fp32' | 'fp16' | 'q8';

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
