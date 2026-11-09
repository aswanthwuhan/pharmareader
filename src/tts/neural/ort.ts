/**
 * Where the browser finds onnxruntime-web at runtime.
 *
 * Both on-device engines load the same ORT build, and both default to a CDN:
 * @huggingface/transformers points `wasmPaths` at jsDelivr, pocket-tts-js points
 * `ortBaseUrl` at a jsDelivr copy of ORT 1.20. `scripts/copy-ort.mjs` copies the
 * runtime that is actually installed (see `ORT_FILES`) into `public/ort/`, and
 * both engines are pointed here instead — so no request ever leaves the device
 * for the runtime, and the app still works offline after the one-time model
 * download.
 *
 * Model weights are the one thing that still come from Hugging Face on first
 * use; the libraries persist them in Cache Storage and read them back after
 * that:
 *   - kokoro-js -> `transformers-cache` (ONNX weights, tokenizer, config) and
 *     `kokoro-voices` (per-voice style tensors)
 *   - pocket-tts-js -> `pocket-tts-js-v1` (models, tokenizer, voices.bin)
 * On Android the same files ship inside the APK (`public/` is bundled), so the
 * native shell is offline from the first launch.
 *
 * `/ort/` is root-relative because `vite.config.ts` uses the default `base: '/'`
 * and Capacitor serves the bundle from the origin root (`https://localhost`).
 */
export const ORT_BASE_URL = '/ort/';
