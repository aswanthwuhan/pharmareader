# Performance: making Kokoro and Pocket TTS faster on Android

The user question this answers: *"can Kokoro or Pocket TTS run faster — e.g. on the GPU?"*
Short answer: **not on the GPU** (nothing on Android today can reach a GPU for these models from
our stack), but **yes, much faster to first sound** — by splitting long sentences into clauses, which
is now in both engines. Measured on the x86_64 emulator (§3): Pocket first audio **23 s → 3–5 s**,
native Kokoro **7–12 s → 1.6 s**.

Numbers below come from the Android emulator (API 36, x86_64, 8 vCPU, WebView 156). The emulator has
no NEON and a software GPU, so **absolute values are not phone values** — every comparison here is
relative (same device, same text, same session).

## 1. What "faster" means here

`RTF` (real-time factor) = synthesis seconds ÷ audio seconds. RTF < 1 is faster than playback, so a
player only has to synthesise each sentence before the previous one ends. Kokoro native is ~0.5
(2× real time); Pocket in the WebView is ~3 (three seconds of work per second of speech), which is
why it needs one-ahead pipelining just to keep up — and why first audio is so late.

Two separate things get measured: **RTF** (throughput, §3.1) and **first-audio latency**
(time from "play" to the first sound, §3.2).

## 2. Options investigated, and their verdicts

### GPU — possible? No (not with anything we ship)

| Route | Verdict |
| --- | --- |
| sherpa-onnx Android AAR (native Kokoro) | **No GPU EP.** `libonnxruntime.so` inside `sherpa-onnx-1.13.8.aar` registers only CPU, XNNPACK and NNAPI execution providers (checked with `strings`/`javap` on the AAR). CUDA/TensorRT/CoreML/QNN symbols appear only in generic provider-list strings, not as usable EPs. A GPU build means compiling sherpa-onnx yourself with `-DSHERPA_ONNX_ENABLE_GPU=ON` plus the vendor SDK (QNN/Qualcomm) — not a prebuilt we can drop in. |
| WebView + WebGPU for Pocket/Kokoro (ORT Web) | **Advertised, but no adapter.** Android System WebView 156 exposes `navigator.gpu`, yet `await navigator.gpu.requestAdapter()` returns **null** on the emulator (software SwiftShader), so `KokoroTTS.from_pretrained(..., device: 'webgpu')` fails and falls back. On a real phone with a Vulkan driver it may work — Chrome for Android ships WebGPU since 113 ([caniuse](https://caniuse.com/webgpu), [Chrome release post](https://developer.chrome.com/blog/webgpu-release)) — but it cannot be verified here, the fp32 Kokoro graph is another ~330 MB download, and quantised (q8/int8) models gain little from the WebGPU EP, which is not the model we ship for WASM. |
| NNAPI (the "GPU/accelerator" door on Android) | **Slower than CPU** in our sweep (§3.1), and NNAPI is **deprecated since Android 15** — Google itself recommends the CPU backend ([Android docs](https://developer.android.com/ndk/guides/neuralnetworks), [ORT NNAPI EP](https://onnxruntime.ai/docs/execution-providers/NNAPI-ExecutionProvider.html)). |

So: **GPU: not possible on Android today** with the prebuilt sherpa-onnx AAR, and WebView WebGPU is
unverifiable here and a poor fit for the quantised models we use.

### WASM threads in the WebView — the one thing that would help, and it cannot be turned on

`onnxruntime-web` only starts a WASM thread pool when the page is **cross-origin isolated**
(`crossOriginIsolated === true`, i.e. `SharedArrayBuffer` exists); without it it pins
`numThreads = 1` ([ORT web env flags](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html)).
Cross-origin isolation comes from COOP+COEP response headers. Capacitor serves the app from
`https://localhost/` through a `WebViewClient` we control, so headers *can* be attached — and they
were: a `BridgeWebViewClient` subclass sent `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: credentialless` (also tried `require-corp`) on the document response.
Chromium (via CDP `Network.getResponseBody`) saw the headers on the navigation response, and they were
still ignored: `crossOriginIsolated` stayed `false`, `typeof SharedArrayBuffer` stayed `"undefined"`,
and COEP was not even enforced (cross-origin images kept loading). Android's WebStorage has no opt-in
either (`android.webkit.WebSettings` on API 36 has no such setting; androidx.webkit 1.12/1.14 have no
symbol for it). **Conclusion: multi-threaded WASM is not reachable in a Capacitor WebView today** —
this is a platform limitation, not a configuration mistake. The code kept for the day it changes is
`src/tts/neural/threadBudget.ts` (returns 4 when isolated, else 1) wired into
`src/tts/neural/pocket.ts` (`maxThreads`) and `src/tts/neural/kokoro.worker.ts`
(`env.backends.onnx.wasm.numThreads`); today it is a no-op because isolation is false.

### Native threads and providers for Kokoro — measured, no free lunch

Full sweep in §3.1: `cpu` at 6 threads is the best combination (RTF 0.525); XNNPACK ties it
(0.533); NNAPI is slower everywhere; 8 threads oversubscribe and are *worse* than 6
(the ORT intra-op pool and XNNPACK's own pool fight for the same cores — ORT's own
[XNNPACK EP guide](https://onnxruntime.ai/docs/execution-providers/Xnnpack-ExecutionProvider.html)
recommends capping spinning for exactly this reason). The native panel therefore keeps
`provider: "cpu"` and does not offer a provider switch — a provider picker would only let the user
pick something measurably worse. The thread selector that was already there stays the knob, and the
panel's Ready line now reports the provider actually in use.

### Native Pocket TTS via sherpa-onnx — real win, but a feature not a switch

`sherpa-onnx-1.13.8.aar` **already contains** Pocket TTS: the Java API has
`OfflineTtsPocketModelConfig` with `setLmFlow/setLmMain/setEncoder/setDecoder/setTextConditioner/`
`setVocabJson/setTokenScoresJson/setVoiceEmbeddingCacheCapacity`, `OfflineTtsModelConfig.setPocket(...)`
and the C++ side has `--pocket-lm-flow … --pocket-token-scores-json` (verified by `javap` and
`strings` on the AAR). No version upgrade is needed — which matters, because newer sherpa-onnx
releases dropped the espeak OOV fallback that keeps Kokoro's lexicon usable.
Model: `sherpa-onnx-pocket-tts-int8-2026-01-26.tar.bz2` (98 MB: `lm_flow.int8.onnx`,
`lm_main.int8.onnx`, `encoder.onnx`, `decoder.int8.onnx`, `text_conditioner.onnx`, `vocab.json`,
`token_scores.json` — [sherpa Pocket docs](https://k2-fsa.github.io/sherpa/onnx/tts/pocket.html)).
It would run in-process with 4 threads and native int8 kernels instead of a single-thread WASM
build (RTF ~3 measured for the WebView version), so RTF well under 1 is plausible.
**The blocker is voice data, not speed:** sherpa's Pocket path is zero-shot cloning — it takes a
`--reference-audio` wav per voice, while the web bundle ships pre-computed voice embeddings
(`voices.bin`). Making it a shippable engine means converting or recording reference audio for each
voice, a model store + plugin method set (mirroring the Kokoro one) and registry wiring — roughly a
day or two of work, listed under LEAD ACTIONS rather than done here.

### ONNX Runtime Android AAR directly for Kokoro

Would give the same EPs we already have (CPU/XNNPACK/NNAPI via sherpa's bundled ORT) and would drop
sherpa's Kokoro front end (`lexicon` + `espeak-ng-data` phonemisation, which ORT does not do), so it
is strictly more work for equal speed. Not pursued.

### Latency tricks that need no new hardware

- **Clause chunking (implemented).** A 25-word sentence is synthesised as one clip before anything
  plays; splitting it at `; : , — –` and at conjunctions (`and/but/or/so/because/while/which/…`) lets
  playback start on the first clause (§3.2). This is the single biggest win for both engines.
- **One clip synthesised ahead of playback** — already how both engines work.
- **Warm-up** — `prepare()` loads the model; the reader screen should call it when an engine is
  selected so the first sentence is not waiting on a 4–6 s model load (LEAD ACTION).

## 3. Measurements

Device: `Medium_Phone_API_36.1`, x86_64, 8 vCPU, 4 GB guest RAM, WebView 156.0.8078.47, app
`com.aurapharmlab.pharmareader` debug build. Text for both tests: a 30-word sentence about the heart
→ 8,029 ms of Kokoro audio. Two runs each after a warm-up run.

Take these numbers on a *settled* emulator: the same synthesis that measures RTF 0.59 when the guest
is idle measured **3.4** with the guest thrashing (free RAM under 200 MB, load average 22), so only
comparisons from one session, one system state, mean anything.

### 3.1 Native Kokoro: provider × threads (RTF, lower is better)

Load time 3.4–5.3 s for every combination; no crash or fallback in any cell.

| threads | cpu | xnnpack | nnapi |
| --- | --- | --- | --- |
| 2 | 0.746 | 0.718 | 0.929 |
| 4 (current default) | 0.591 | 0.633 | 0.648 |
| 6 | **0.525** | 0.533 | 0.611 |
| 8 | 0.717 | 1.145 | 0.847 |

Same sentence via `Kokoro.synthesize`, reading the plugin's own `rtf` field.

### 3.2 First audio: one long clip vs clause chunks (ms)

| engine | one clip (before) | clause chunks (after) | change |
| --- | --- | --- | --- |
| Pocket (WebView) | 23,381 / 26,902 | **5,205 / 2,933** | 4.5–9× sooner |
| Kokoro (native, 4 threads) | 7,134 / 11,840 | **1,585 / 1,777** | 4.5–6.7× sooner |

RTF is unchanged by chunking (same audio, same total work): Pocket stays ~2.9–3.5 (single WASM
thread), Kokoro ~0.59 at 4 threads.

## 4. What changed in the code

- `src/tts/neural/clauseChunk.ts` (+ `clauseChunk.test.ts`, 11 tests) — splits a long sentence into
  clause chunks and plans the play order, preserving the text exactly (chunks join back to the
  original) and keeping `onStart`/`onEnd` once per sentence.
- `src/tts/neural/pocket.ts`, `src/tts/native/kokoroNativeEngine.ts` — `speak()` now plays chunks
  instead of whole sentences; `synthesize()` is untouched so prerendering and the audio cache still
  store one clip per sentence.
- `src/tts/neural/threadBudget.ts` (+ tests) — thread count for ORT WASM when isolation is available.
- `src/tts/neural/kokoro.ts` — `usableDevice()` asks `navigator.gpu.requestAdapter()` once
  before choosing WebGPU, so a WebView that advertises the API but hands out no adapter goes
  straight to WASM/q8 instead of downloading the fp32 weights for a session that cannot be created
  (measured: WebView 156 on the emulator returns `null`).
- `android/.../kokoro/KokoroTtsEngine.java`, `KokoroPlugin.java` — `provider` is a load parameter and
  is reported back in `status()`, so the sweep above is reproducible from the panel or CDP; value is
  clamped to the three providers the AAR actually ships, and the panel's Ready line shows it.

## 5. Reproducing on a real phone

```powershell
# build + install as in docs/ANDROID.md, then
adb forward tcp:9333 localabstract:webview_devtools_remote_$(adb shell pidof com.aurapharmlab.pharmareader)
# threads/providers for native Kokoro (rtf in the result):
node .tmp/emu-final/ui.mjs eval "window.Capacitor.Plugins.Kokoro.load({threads:6,provider:'cpu'})"
node .tmp/emu-final/ui.mjs eval "window.Capacitor.Plugins.Kokoro.synthesize({text:'This is a test sentence for the speech engine.',sid:3,speed:1})"
```
On a real phone expect: Kokoro RTF roughly 0.2–0.4 at 4 threads (big cores), Pocket ~1.5–3 until it
can use threads, and the same first-audio improvement from chunking. Worth re-running the thread sweep
on the phone — if 6 threads consistently wins there too, raising the default from 4 is a one-line
change (LEAD ACTION).
