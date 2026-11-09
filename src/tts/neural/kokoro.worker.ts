/**
 * Kokoro-82M worker. Runs `kokoro-js` (transformers.js + onnxruntime-web) off
 * the UI thread: ~300 MB of WASM memory plus multi-second inference would
 * freeze the reader otherwise. WebGPU when the browser has it, WASM otherwise.
 */
import { KokoroTTS } from 'kokoro-js';
import type { KokoroDevice, KokoroDtype, KokoroRequest, KokoroResponse } from './kokoroProtocol';
import { createProgressAggregator } from './progress';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

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

scope.onmessage = (event) => {
  void handle(event.data);
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
  const report = createProgressAggregator((fraction) => post({ type: 'progress', fraction }));
  tts = await KokoroTTS.from_pretrained(MODEL_ID, {
    dtype,
    device,
    progress_callback: (info) => {
      if (info.status === 'progress') report({ label: info.file, loaded: info.loaded, total: info.total });
    },
  });
  post({ type: 'ready', voices: Object.keys(tts.voices) });
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
