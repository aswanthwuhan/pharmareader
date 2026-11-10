/**
 * How many WASM threads the in-browser neural engines get.
 *
 * onnxruntime-web runs its graph on one thread unless the document is
 * <em>cross-origin isolated</em> — `self.crossOriginIsolated === true`, which a browser
 * only grants when the document itself was served with `Cross-Origin-Opener-Policy:
 * same-origin` plus `Cross-Origin-Embedder-Policy`. Nothing else (no feature flag, no
 * ORT setting) can raise the thread count: without isolation there is no
 * `SharedArrayBuffer`, and without `SharedArrayBuffer` ORT's thread pool cannot exist.
 *
 * That single difference is what made the WebView engines several times slower than real
 * time on a phone. The header route was tried and does not work in Android's WebView — the
 * headers arrive on the document response and Chromium still refuses to isolate the page
 * (measurements in docs/PERFORMANCE.md) — so this stays 1 on Android today and the value
 * here simply documents the budget for browsers that do isolate.
 *
 * Threads are capped at four on purpose: the synthesis worker shares the phone's cores
 * with the UI thread and the audio pipeline, and measured gains flatten past four.
 */
export const MAX_WASM_THREADS = 4;

export interface ThreadBudgetEnv {
  /** `self.crossOriginIsolated` (absent outside a browser). */
  crossOriginIsolated?: boolean;
  /** `navigator.hardwareConcurrency`. */
  hardwareConcurrency?: number;
}

/**
 * 1 when the context is not isolated (ORT stays single-threaded whatever we ask for),
 * otherwise the core count capped at {@link MAX_WASM_THREADS}, never below 2.
 */
export function wasmThreadCount(env: ThreadBudgetEnv = currentEnv()): number {
  if (env.crossOriginIsolated !== true) return 1;
  const cores = Math.floor(env.hardwareConcurrency ?? 0);
  if (!(cores >= 2)) return 1;
  return Math.min(cores, MAX_WASM_THREADS);
}

function currentEnv(): ThreadBudgetEnv {
  const scope = globalThis as { crossOriginIsolated?: boolean; navigator?: Navigator };
  const cores = scope.navigator?.hardwareConcurrency;
  return { crossOriginIsolated: scope.crossOriginIsolated, hardwareConcurrency: cores };
}
