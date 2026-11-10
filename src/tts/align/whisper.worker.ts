/**
 * Whisper tiny (on device) for read-along timings.
 *
 * Runs transformers.js + onnxruntime-web off the UI thread. The clip is decoded
 * and resampled by the page (Web Audio lives on the main thread); this worker
 * only executes the model and returns one timestamped word per token.
 *
 * The model is `whisper-tiny.en_timestamped`: the plain exports do not carry
 * cross-attention outputs, and transformers.js needs them to turn attention into
 * word timings ("Model outputs must contain cross attentions to extract
 * timestamps"). It is loaded as q8 to keep the download at ~42 MB.
 */
import { env, pipeline } from '@huggingface/transformers';
import { messageOf } from '../neural/neuralError';
import { ORT_BASE_URL } from '../neural/ort';
import { createProgressAggregator } from '../neural/progress';
import type { ChunkTiming } from './align';
import { transcriptFromChunks } from './align';
import { WHISPER_SAMPLE_RATE } from './decode';
import { WHISPER_SIZE_BYTES } from './size';
import type { WhisperRequest, WhisperResponse } from './whisperProtocol';
import { WHISPER_MODEL_ID } from './whisperProtocol';

/**
 * Same ORT setup as the voice workers: the runtime comes from the app's own
 * `/ort/` copy, addressed absolutely so Vite's dev server does not try to serve
 * `public/` through its module pipeline (see `kokoro.worker.ts`).
 */
const ORT_WASM_BASE = new URL(ORT_BASE_URL, self.location.href).href;

const onnxEnv = env as unknown as {
  backends: { onnx: { wasm: { wasmPaths?: string | Record<string, string> } } };
  useBrowserCache: boolean;
  allowLocalModels: boolean;
};
onnxEnv.backends.onnx.wasm.wasmPaths = ORT_WASM_BASE;
// Cache Storage is unavailable in private mode and in some old WebViews, where
// transformers.js would throw instead of downloading: opt out and re-fetch.
onnxEnv.useBrowserCache = typeof caches !== 'undefined';
// The browser build has no `public/models/` directory to probe.
onnxEnv.allowLocalModels = false;

interface WorkerScope {
  postMessage(message: WhisperResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WhisperRequest>) => void) | null;
}

const scope = self as unknown as WorkerScope;

function post(message: WhisperResponse): void {
  scope.postMessage(message);
}

interface AsrChunk {
  text: string;
  /** Word timestamps are `[start, end]` in seconds; null when the token has none. */
  timestamp?: [number | null, number | null];
}

interface AsrOutput {
  text: string;
  chunks?: AsrChunk[];
}

type Asr = (audio: Float32Array, options?: Record<string, unknown>) => Promise<AsrOutput>;

let asr: Asr | null = null;
let loading: Promise<Asr> | null = null;

/**
 * Throw the loaded pipeline away. A session that has failed once (an ONNX
 * error, or the wasm heap running out late in a long reading session) does not
 * come back healthy on its own, and the next clip must not reuse it: dropping
 * it here makes the next `load()` build a fresh session, and disposing releases
 * the old one's memory first.
 */
async function discard(): Promise<void> {
  const model = asr as (Asr & { dispose?: () => Promise<void> }) | null;
  asr = null;
  loading = null;
  if (!model?.dispose) return;
  try {
    await model.dispose();
  } catch {
    // Nothing left to release.
  }
}

/** Load the model once; concurrent requests share the one download. */
function load(): Promise<Asr> {
  if (asr) return Promise.resolve(asr);
  if (!loading) {
    const report = createProgressAggregator(
      (fraction) => post({ type: 'progress', fraction }),
      WHISPER_SIZE_BYTES
    );
    loading = (async () => {
      const model = (await pipeline('automatic-speech-recognition', WHISPER_MODEL_ID, {
        device: 'wasm',
        dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
        progress_callback: (info: unknown) => report(info as Parameters<typeof report>[0]),
      })) as unknown as Asr;
      asr = model;
      return model;
    })();
    // A failed load must be retryable; the awaiting caller still sees the error.
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

/** One request at a time: an ONNX session is not re-entrant. */
let queue: Promise<void> = Promise.resolve();

function enqueue(task: () => Promise<void>): void {
  queue = queue.then(task, task).catch(() => undefined);
}

async function align(id: number, audio: Float32Array, sampleRate: number): Promise<void> {
  if (sampleRate !== WHISPER_SAMPLE_RATE) {
    throw new Error(`The aligner needs ${WHISPER_SAMPLE_RATE} Hz audio, got ${sampleRate} Hz`);
  }
  const model = await load();
  const started = performance.now();
  let output: AsrOutput;
  try {
    output = await model(audio, { return_timestamps: 'word' });
  } catch (err) {
    // The failed session is what makes every later clip fail too; discard it so
    // the next request starts from a fresh one. This one still reports the error.
    await discard();
    throw err;
  }

  const chunks: ChunkTiming[] = [];
  for (const chunk of output.chunks ?? []) {
    const timestamp = chunk.timestamp;
    if (!timestamp) continue;
    const start = timestamp[0];
    const end = timestamp[1];
    if (start === null || end === null) continue;
    chunks.push({ text: chunk.text, startMs: start * 1000, endMs: end * 1000 });
  }

  post({
    type: 'result',
    id,
    words: transcriptFromChunks(chunks),
    text: (output.text ?? '').trim(),
    ms: performance.now() - started,
  });
}

scope.onmessage = (event: MessageEvent<WhisperRequest>) => {
  const message = event.data;
  enqueue(async () => {
    try {
      switch (message.type) {
        case 'init':
          await load();
          post({ type: 'ready' });
          return;
        case 'align':
          await align(message.id, message.audio, message.sampleRate);
          return;
      }
    } catch (err) {
      post({
        type: 'error',
        id: message.type === 'align' ? message.id : undefined,
        message: messageOf(err),
      });
    }
  });
};
