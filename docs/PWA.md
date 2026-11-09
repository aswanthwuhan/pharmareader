# PWA (PharmaReader)

**Install it:** https://aswanthwuhan.github.io/pharmareader/ — served from `/pharmareader/`, built with
`VITE_BASE=/pharmareader/` and deployed by `.github/workflows/pages.yml` on every push to `master`.
Plain `pnpm build` (no `VITE_BASE`) still produces the root-path bundle used by dev, Android and Windows.

## Install
- **Android (Chrome):** open the URL → ⋮ menu → **Install app** (or "Add to Home screen").
- **iPhone/iPad (Safari):** open the URL → **Share** → **Add to Home Screen**.
- **Windows/macOS (Chrome or Edge):** open the URL → install icon in the address bar
  (Edge: ⋯ menu → Apps → Install this site as an app).

## Offline
- App shell, ORT runtime (`/pharmareader/ort/`) and imported books live on the device (service worker +
  IndexedDB), so library, reader, study and TTS settings work offline.
- Neural TTS models are not bundled: Pocket/Kokoro weights download from Hugging Face on first use and
  are cached; System voices work offline from the start.
- A new deploy updates in the background — reload once when the app says an update is ready.
- CI needs repo Settings → Pages → Source: **GitHub Actions** (one-time).
- Backup (Settings → Backup) is the only copy of your books and cards — Pages stores nothing.
