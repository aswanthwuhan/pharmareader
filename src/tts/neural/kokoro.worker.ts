/**
 * Kokoro-82M worker. Runs `kokoro-js` (transformers.js + onnxruntime-web) off
 * the UI thread: ~300 MB of WASM memory plus multi-second inference would
 * freeze the reader otherwise. WebGPU when the browser has it, WASM otherwise.
 */
import { env as transformersEnv } from '@huggingface/transformers';
import { KokoroTTS, env } from 'kokoro-js';
import type { KokoroDevice, KokoroDtype, KokoroRequest, KokoroResponse } from './kokoroProtocol';
import { createProgressAggregator } from './progress';
import { ORT_BASE_URL } from './ort';
import { kokoroSizeMb } from './sizes';
import { wasmThreadCount } from './threadBudget';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

/**
 * The worker's own URL is the base for the ORT runtime. Transformers.js imports
 * the Emscripten glue (`ort-wasm-simd-threaded.jsep.mjs`) dynamically at run
 * time; when the specifier is a root-relative path, Vite's dev server resolves
 * it into `public/` and refuses to serve it (`?import` → 500 "This file is in
 * /public ... should not be imported from source code"). Passing an absolute
 * URL — same bytes, same origin — keeps Vite's transform pipeline out of the
 * way and works identically in a production build, on Capacitor and on Pages.
 */
const ORT_WASM_BASE = new URL(ORT_BASE_URL, self.location.href).href;

/**
 * `env.wasmPaths` is the kokoro-js alias for `env.backends.onnx.wasm.wasmPaths`
 * (transformers.js otherwise defaults it to a jsDelivr URL). Assigning it here,
 * before `from_pretrained()` loads the runtime, keeps onnxruntime-web on the
 * app's own `/ort/` copy. The weights still come from Hugging Face once, then
 * live in Cache Storage (`transformers-cache`, `kokoro-voices`), so a second
 * launch is fully offline.
 */
env.wasmPaths = ORT_WASM_BASE;

/**
 * Threads. onnxruntime-web picks its own default (`min(4, ceil(cores / 2))`), but it only
 * does that when the page is cross-origin isolated; otherwise it pins itself to one thread.
 * Setting the number here makes the intent explicit and keeps the two engines on the same
 * budget, so a measurement is comparable between Kokoro and Pocket.
 */
// kokoro-js' `env` is a wrapper with nothing but `wasmPaths`: `env.backends` is
// undefined there and the worker died at load ("reading 'onnx'"). The runtime
// settings live on transformers.js' own `env`, the same module kokoro-js uses.
const onnxWasm = transformersEnv.backends.onnx.wasm;
if (onnxWasm) onnxWasm.numThreads = wasmThreadCount();

/**
 * transformers.js caches the weights in Cache Storage (`transformers-cache`).
 * That is unavailable in private mode and in some old Android WebViews, where it
 * throws instead of downloading — opt out there and simply re-fetch. The flag is
 * on transformers.js' `env`; kokoro-js re-exports a narrower type for it.
 */
transformersEnv.useBrowserCache = typeof caches !== 'undefined';

interface WorkerScope {
  postMessage(message: KokoroResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<KokoroRequest>) => void) | null;
}

const scope = self as unknown as WorkerScope;

function post(message: KokoroResponse, transfer?: Transferable[]): void {
  scope.postMessage(message, transfer ?? []);
}

let tts: KokoroTTS | null = null;
/** Request currently being synthesised; -1 once `stop` was received. */
let currentId = -1;
/** ONNX sessions are not re-entrant: init/speak run one after another. */
let queue: Promise<void> = Promise.resolve();

scope.onmessage = (event) => {
  const msg = event.data;
  // `stop` must act on the running synthesis immediately, not after a queue.
  if (msg.type === 'stop') {
    currentId = -1;
    return;
  }
  queue = queue.then(() => handle(msg));
};

async function handle(msg: KokoroRequest): Promise<void> {
  const id = msg.type === 'speak' ? msg.id : undefined;
  try {
    if (msg.type === 'init') await init(msg.dtype, msg.device);
    else if (msg.type === 'speak') await speak(msg.id, msg.text, msg.voice, msg.speed);
    else currentId = -1; // stop: drop the result of the in-flight synthesis
  } catch (err) {
    post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
}

async function init(dtype: KokoroDtype, device: KokoroDevice): Promise<void> {
  if (tts) {
    post({ type: 'ready', voices: Object.keys(tts.voices) });
    return;
  }
  const report = createProgressAggregator(
    (fraction) => post({ type: 'progress', fraction }),
    // The tokenizer lands first; without a known total the bar would read 99%
    // for the whole 92 MB weights download.
    kokoroSizeMb(dtype) * 1e6
  );
  try {
    tts = await load(dtype, device, report);
  } catch (err) {
    // WebGPU can be advertised but still fail (old driver, no adapter). Retry on
    // WASM with the same weights instead of leaving the engine unusable.
    if (device !== 'webgpu') throw err;
    tts = await load(dtype, 'wasm', report);
  }
  post({ type: 'ready', voices: Object.keys(tts.voices) });
}

async function load(
  dtype: KokoroDtype,
  device: KokoroDevice,
  report: (info: { label?: string; loaded?: number; total?: number }) => void
): Promise<KokoroTTS> {
  return KokoroTTS.from_pretrained(MODEL_ID, {
    dtype,
    device,
    progress_callback: (info) => {
      if (info.status === 'progress') report({ label: info.file, loaded: info.loaded, total: info.total });
    },
  });
}

async function speak(id: number, text: string, voice: string, speed: number): Promise<void> {
  if (!tts) throw new Error('Kokoro model is not loaded');
  currentId = id;
  const audio = await tts.generate(text, { voice: voice as keyof KokoroTTS['voices'], speed });
  if (currentId !== id) {
    post({ type: 'stopped', id });
    return;
  }
  const pcm = audio.audio;
  // Transfer instead of copy: a sentence is up to a few MB of Float32.
  post({ type: 'result', id, audio: pcm, sampleRate: audio.sampling_rate }, [pcm.buffer as ArrayBuffer]);
}
