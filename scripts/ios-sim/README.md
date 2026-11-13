# iOS Simulator check (mobile Safari, live site or a local build)

The Windows workstation cannot run an iOS Simulator, so this directory drives the
app in **real mobile Safari inside a GitHub macOS runner** — either the deployed site or,
in *local build* mode, the commit that was just pushed, built and served on the runner
itself. It runs on
[`.github/workflows/ios-sim.yml`](../../.github/workflows/ios-sim.yml) against two runner
images at once — `macos-15` (Xcode 16, iOS 18.x simulators) and `macos-26` (Xcode 26,
iOS 26.x) — so two iOS versions are covered per run. The repository is public, so macOS
minutes are free.

> `macos-14` (iOS 17.x) used to be the second leg. GitHub retired every macOS 14 image on
> 2026-11-02 ([actions/runner-images#15226](https://github.com/actions/runner-images/issues/15226)),
> so that label fails before the job starts and `macos-26` took its place. If an iOS 17
> runtime is ever wanted again it has to come from a self-hosted or paid runner image.

Everything is a **report**, not a gate: the job stays green and the verdict lands in
`summary.json` plus the artifact files. Open the artifact, do not trust the green tick.

## Files

| file | what it does |
|---|---|
| `pick-sim.mjs` | reads `xcrun simctl list -j`, picks the newest available iPhone on the newest available iOS runtime, exports `IOS_SIM_UDID` / `IOS_SIM_DEVICE_NAME` / `IOS_SIM_PLATFORM_VERSION` / `IOS_SIM_RUNTIME` to `$GITHUB_ENV` |
| `run.mjs` | the test: one session on the tested URL, steps a–f (`c2.tts-probe` included), JSON-line log, screenshots, `summary.json` |
| `package.json` / `package-lock.json` | WebdriverIO client for `run.mjs` alone (the root `package.json` is untouched; CI runs `npm ci` inside this directory) |

## Triggering a run

**Once this file is on the default branch** (`master`):

```bash
gh workflow run ios-sim.yml                                   # live Pages URL
gh workflow run ios-sim.yml -f url=https://aswanthwuhan.github.io/pharmareader/
gh workflow run ios-sim.yml -f driver=safaridriver            # fallback driver
gh workflow run ios-sim.yml -f build=true                     # build this commit, test that
gh run watch                                                  # follow it
```

**Before it is merged**, push the branch `ios-sim` — the workflow also triggers on that
branch only, so the lead can run it without touching `master`:

```bash
git push origin ios-sim
```

Inputs: `url` (page to open, default `https://aswanthwuhan.github.io/pharmareader/`),
`driver` (`appium` default, or `safaridriver`: the same test over Apple's own WebDriver
with `safari:useSimulator` + `safari:deviceUDID`, after `sudo safaridriver --enable` —
no WebDriverAgent build, but no element tap either), and `build` (`false` default).

## The two modes

| mode | when | what is tested |
|---|---|---|
| **live-url** | `workflow_dispatch` with `build=false` (the default) | `url` / the Pages site: what users get today |
| **local-build** | a push to `ios-sim`, or `workflow_dispatch` with `build=true` | the pushed commit: pnpm 12 + Node 24, `pnpm install --frozen-lockfile`, `VITE_BASE=/pharmareader/ pnpm build`, `dist` served by `vite preview` at `http://localhost:4173/pharmareader/` |

A push to `ios-sim` always builds — that is the point of the branch: test the working tree
before it is deployed. In local-build mode the workflow starts `vite preview` on port 4173
and polls it before the simulator runs, so a broken build fails in seconds instead of
showing up as a blank page twenty minutes into WDA setup. `localhost` (not `127.0.0.1`) is
used because it is a secure context in Safari, so the service worker registers; if the
runner's `localhost` does not resolve to the listener the step falls back to
`http://127.0.0.1:4173/pharmareader/` (also loopback, also a secure context) and says so
with a `::warning::`. The URL actually used is `summary.json` → `urlTested`, and `mode` is
`live-url` or `local-build`.

## What the log looks like

`run.mjs` prints one JSON object per line (`{"at":…,"event":…}`) and repeats it in
`run.log`. WebdriverIO's own protocol log is quiet by default; set
`IOS_SIM_WDIO_LOG=info` in the environment to get every `[POST] /session/...` line back
when a run needs debugging.

## Fetching the results

```bash
gh run list --workflow=ios-sim.yml
gh run download --name ios-sim-macos-15        # or ios-sim-macos-26
```

`ios-sim-artifacts/` then contains:

| file | what it shows |
|---|---|
| `summary.json` | pass/fail per step, timings, `urlTested` and `mode`, captured user agent, console errors, driver/caps, device and runtime, and the `ttsProbe` block (app log + P1–P4) |
| `run.log` | the same JSON lines the step printed |
| `NN-<step>.png` / `NN-<step>.html` | WebDriver screenshot + DOM source after each step (`-failed` when the step threw) |
| `simctl-final.png` | `xcrun simctl io booted screenshot` at the end — the simulator's own screen, even when no session was ever created |
| `appium.log`, `appium-status.json`, `appium-drivers.txt` | Appium server log and installed-driver listing |
| `simulator.json`, `simctl-inventory.txt`, `xcode-version.txt` | which runtime/device was chosen, and what the image had |
| `vite-preview.log`, `vite-preview.pid`, `vite-preview-index.html` | local-build mode only: the `vite preview` server, its pid, and the index it served |

## What the steps check

| step | check |
|---|---|
| `a.library-load` | `/` loads, `#root` shows "Library"; records `navigator.userAgent`, `window.onerror` / `unhandledrejection` messages, and whether `navigator.serviceWorker.controller` is set after a reload |
| `b.import-text` | builds a `File` from a string and feeds it to the library's `<input type=file>` through `DataTransfer` + a `change` event (mobile Safari cannot set files through WebDriver), then opens the book and waits for the reader text |
| `c.play-tts` | injects a `speechSynthesis` wrapper (`window.__ttsProbe`) that logs every `speak()` / `cancel()` / `resume()` / `pause()` and every `start` / `end` / `error` / `boundary` event on the utterances it is given, then presses the player's Play button and records `speechSynthesis.speaking`, `.pending`, the player's state text and any errors at **3 s and 9 s**. Then a **positive control**: a probe button that calls `speak()` with no app code involved, tapped the same way — that separates "the app never reached `speak()`" from "WebKit accepted and dropped it" |
| `c2.tts-probe` | the control experiments, on a fresh `?probe=1` page of the same origin (same secure context, same service worker): four full-screen buttons, each tapped with the **same real WDA tap** step c uses, sampled in-page every 250 ms for 3.25 s, `cancel()` + 1 s between them. `P1 direct` = `speak(utterance)`; `P2 cancel-then-speak` = `cancel(); speak(utterance)`; `P3 app-like` = `speak(empty)` then, out of the gesture and 300 ms later, `cancel(); speak(utterance)`; `P4 unlock-then-later` = `speak(empty)` then 300 ms later `speak(utterance)`, no cancel. For each: did `start` fire, was `speaking` ever true, did `end` fire, and the `error` code if any |
| `d.import-pdf` | imports a one-page PDF built into the script, opens "Page" view and checks the `.rd-pdf-canvas` for non-white pixels — this is the pixel-level check that the PDF transfer fix actually renders |
| `e.settings-tts` | opens `/settings` and records the TTS/Listening section text |
| `f.simulator-artifacts` | `xcrun simctl io booted screenshot` |

The TTS verdicts are in `summary.json` under `ttsProbe` — `app` (the `3 s` / `9 s` reads,
the canary, and the app's whole `__ttsLog`), and `experiments` (the four rows of `c2` with
their event logs and speaking samples). The step summary carries the same four rows as a
table plus the app's log, so the answer is visible without downloading the artifact.

## Notes for whoever runs this

- The first Appium run on a fresh runner builds WebDriverAgent for the simulator: expect
  **5–10 minutes** before the first command answers. That is why the step timeouts are
  long and the session uses `connectionRetryTimeout: 900000`.
- A session can still be refused (iOS 18/26 Safari automation quirks, a simulator with no
  voices, WDA signing, an Appium release that predates the runner's Xcode). `run.mjs` then
  records the failure in `summary.json` and still exits 0; the workflow screenshot proves
  the simulator itself was up.
- `run.mjs` never fails the build on purpose. Grep the log for `"ok":false`, or read
  `summary.json`.
- Versions are pinned because the Appium pair must match: `APPIUM_VERSION=3.9.0` with
  `XCUITEST_VERSION=12.22.8` (the xcuitest 13.x line requires Appium 4 betas).
- `d.import-pdf` needs **≥ 25 ink pixels** in a 120×160 probe of the page canvas; the live
  Chromium run measures ~300, an empty `<canvas>` measures 0.
- Local checks that need no simulator: `node --check scripts/ios-sim/run.mjs`,
  `SIMCTL_JSON=some.json node scripts/ios-sim/pick-sim.mjs` (that env var replaces
  `xcrun simctl list -j` with a saved inventory), and a mock WebDriver endpoint on
  `IOS_SIM_APPIUM_PORT` to exercise `run.mjs` end to end on a workstation.
- **Mock endpoint gotcha:** WebdriverIO 9 sends every `execute` wrapped as
  `function webdriverioPolyfill() {…}\nwebdriverioPolyfill();\nreturn (function NAME(…){…}).apply(…)`,
  so a mock that names the injected function with the *first* `function NAME(` in the
  script always sees `webdriverioPolyfill`. Take the **last** one, or answer by markers.
- The probe page (`?probe=1`) is the app's own origin but not the app's UI: it is a white
  overlay of four buttons drawn by `installProbeButtons()`, so it works without voices,
  without a library and without the service worker being ready. `probeReady()` waits for
  the four buttons, not for voices — Safari fills `getVoices()` lazily, so requiring
  voices would stall every run.
- Playwright/Chromium can validate the probe scripts without a simulator: slice
  `run.mjs` from `function installTtsProbe(` to the `/* --- WebDriver plumbing` marker,
  load it on `http://localhost:4173/pharmareader/?probe=1` (local-build mode) and click
  the four buttons — real clicks, results match the table shape in `summary.json`.
