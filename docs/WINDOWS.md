# PharmaReader on Windows (Tauri 2)

## Install
- Download `PharmaReader_0.1.0_x64-setup.exe` from the GitHub release and run it; it installs per user, no admin prompt.
- Unsigned build: SmartScreen shows "Windows protected your PC" — click **More info → Run anyway**.
- Needs WebView2 (preinstalled on Win10/11); the installer fetches Microsoft's bootstrapper if it is missing.

## Offline
- Same Vite bundle as the PWA, built with `--mode native` (no service worker); all data stays on device.
- Neural voices download weights once from Hugging Face, then live in the WebView cache; system voices need nothing.
- SharedArrayBuffer (multithreaded WASM) comes from `COOP: same-origin` + `COEP: credentialless` — `credentialless` rather than `require-corp` because HF model files are CORS responses (`Access-Control-Allow-Origin: *` on the `cdn-lfs`/`xet` redirect) and article pages can still use cross-origin images.

## Data
- `%LOCALAPPDATA%\com.aurapharmlab.pharmareader` — the WebView2 profile: `EBWebView\Default\IndexedDB` (library, highlights, cards), cache (TTS models, audio).
- Uninstalling keeps that folder; export Settings → Backup first, and delete the folder to reset.

## Build
- `pnpm install`, then `pnpm win:build` → `src-tauri\target\release\bundle\nsis\PharmaReader_0.1.0_x64-setup.exe` (first build compiles Rust, several minutes).
- `pnpm tauri dev` runs a hot-reloading shell against `http://localhost:5173`.
- Not included yet: code signing, auto-updater; OS voices still go through the Web Speech API.
