/**
 * Messages between the read-along aligner and its worker.
 *
 * The clip is decoded on the main thread (Web Audio lives there) and sent as
 * 16 kHz mono samples, so the worker only runs the model.
 */
import type { TranscriptWord } from './types';

export type WhisperRequest =
  | { type: 'init' }
  | { type: 'align'; id: number; audio: Float32Array; sampleRate: number };

export type WhisperResponse =
  | { type: 'progress'; fraction: number }
  | { type: 'ready' }
  | { type: 'result'; id: number; words: TranscriptWord[]; text: string; ms: number }
  | { type: 'error'; id?: number; message: string };

/** The model transformers.js loads: the q8 export that keeps cross-attention heads. */
export const WHISPER_MODEL_ID = 'onnx-community/whisper-tiny.en_timestamped';
