/**
 * onnxruntime-web, loaded from the app's own `/ort/` copy at runtime.
 *
 * Vite would otherwise have to bundle the package — which is not even a direct
 * dependency here (pnpm only keeps it in the store, pulled in by kokoro-js), so
 * the bare specifier would not resolve. Loading `ort.min.mjs` by URL instead
 * uses the runtime `scripts/copy-ort.mjs` already ships for the TTS engines, so
 * the layout model and the voices share one 21 MB `.wasm` on disk and the layout
 * code adds no JS to the main bundle.
 *
 * The handles below cover the handful of calls the detector makes; the rest of
 * the runtime stays untyped rather than pulling a whole type package in.
 */
import { ORT_BASE_URL } from '../../tts/neural/ort';

export interface OrtTensor {
  readonly data: Float32Array | Int32Array | Uint8Array | BigInt64Array;
  readonly dims: readonly number[];
}

export interface OrtSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  /** With `names`, the runtime computes only those outputs. */
  run(feeds: Record<string, OrtTensor>, names?: readonly string[]): Promise<Record<string, OrtTensor>>;
}

export interface OrtModule {
  env: { wasm: { wasmPaths?: string; numThreads?: number; proxy?: boolean } };
  Tensor: new (type: 'float32', data: Float32Array, dims: readonly number[]) => OrtTensor;
  InferenceSession: {
    create(
      bytes: Uint8Array,
      options?: { executionProviders?: string[]; graphOptimizationLevel?: string },
    ): Promise<OrtSession>;
  };
}

let loading: Promise<OrtModule> | null = null;

export function loadOrt(): Promise<OrtModule> {
  loading ??= (async () => {
    // An absolute URL, built at runtime: a bare `/ort/ort.min.mjs` specifier is
    // rewritten by Vite into a project import, and Vite refuses to import
    // anything from `public/` (it is copied as-is, never transformed). A full
    // http(s) URL is left alone, and the file is fetched as the static asset it
    // is in both dev and the built app.
    const href = new URL(`${ORT_BASE_URL}ort.min.mjs`, globalThis.location.origin).href;
    const ort = (await import(/* @vite-ignore */ href)) as unknown as OrtModule;

    // Neither the Android WebView nor Tauri has cross-origin isolation by
    // default, and without `SharedArrayBuffer` the threaded build runs on one
    // thread anyway: ask for one explicitly instead of letting the runtime warn
    // about it on every import. A WebView that does serve the page isolated (the
    // Android host adds the headers for the voice engines too) gets real threads,
    // which is most of the difference between a page taking seconds and a page
    // taking one.
    ort.env.wasm.numThreads = globalThis.crossOriginIsolated
      ? Math.min(4, globalThis.navigator?.hardwareConcurrency || 1)
      : 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = ORT_BASE_URL;

    return ort;
  })();

  return loading;
}
