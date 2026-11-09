# PharmaReader — MD Pharmacology study reader (plan)

## Context
MD Pharmacology residents (India) need one app to study their own textbooks/notes with listen-along TTS, highlights and spaced-repetition flashcards, organized by the NMC syllabus from basic to advanced. Inspired by OpenReader-WebUI (MIT, Next.js) but offline-first and phone-first. Empty project folder — greenfield. Built by user + Claude.

## Decisions (from grill session)
| Area | Decision |
|---|---|
| Content | User imports own files only (no bundled copyrighted content) |
| Formats v1 | Text PDF, EPUB, DOCX, TXT/MD, web article. OCR = later |
| Stack | One Vite + React + TS web app → PWA; Capacitor (Android, later iOS); Tauri (Windows, later) |
| TTS | Pluggable engines, user selects: System voice (prompt user to install Premium/Enhanced or high-quality OS voice) / Pocket TTS streaming (fast offline neural, mid+budget phones) / Kokoro streaming / Kokoro pre-render . On-device only — no PC/server. Android Kokoro = native sherpa-onnx Capacitor plugin (CPU, 4 threads); PWA/desktop Kokoro = kokoro-js. Default auto-picked by device speed |
| Pronunciation | Built-in pharma lexicon + user-editable entries, applied before every engine |
| Study features v1 | Read-along sentence highlight, highlights/notes/bookmarks, FSRS flashcards |
| Levels | Built-in NMC MD Pharmacology topic tree (Basic/Intermediate/Advanced), editable; chapters + cards tagged to topics; per-topic progress |
| Data | Local-first (IndexedDB). Backup export/import zip. No backend/accounts v1 |
| AI | v1: BYO API key (OpenAI-compatible endpoint: OpenAI/DeepSeek/Gemini/Claude), off by default. v2: local LLM, RAM-gated |
| License | GPL-3.0 open source (espeak-ng phonemizer OK) |
| Ship order | PWA + Android first; iOS + Windows next |

## Key facts that shaped design
- On-device Kokoro: flagship Android ~20–40 s compute per 1 min audio; budget phones slower than real-time; iPhone ~800 MB RAM; int8 often slower than fp32. WebView/WASM slower still → system-voice fallback + background pre-render + audio cache are mandatory, not optional.
- Kokoro model downloaded on first use (not bundled), cached; user picks q8 (~90 MB) or fp32 (~320 MB).

## Libraries (reuse, don't write)
- PDF: `pdfjs-dist` (page view + text positions for highlight boxes)
- EPUB: `foliate-js` (MIT) or `epub.js`
- DOCX: `mammoth`; articles: `@mozilla/readability` (native HTTP via Capacitor/Tauri to dodge CORS; PWA = paste URL works only where CORS allows, else paste text)
- Sentence split: `Intl.Segmenter`
- Kokoro: `kokoro-js` in a Web Worker (WebGPU → WASM fallback)
- Pocket TTS (Kyutai, ~100M, int8 ONNX ~148 MB): `pocket-tts-js` (MIT) in a Web Worker, streaming. Weights CC-BY-4.0 → show Kyutai attribution in About. Use only voices with a clear license; no voice cloning (gated weights)
- System TTS: Web Speech API (PWA/Tauri), `@capacitor-community/text-to-speech` (Android/iOS)
- Storage: `dexie` (IndexedDB) + `navigator.storage.persist()`
- SRS: `ts-fsrs`
- PWA: `vite-plugin-pwa`
- Backup: `fflate` zip

## Architecture (core modules)
- `src/import/` — per-format extractors → common `Doc { chapters[] → blocks[] → sentences[] }` with source locators (PDF page+rects, EPUB CFI).
- `src/tts/` — `TtsEngine` interface `{ speak(sentence), prerender(sentences), stop, capabilities }`; engines: `system`, `pocketWorker`, `kokoroWorker` (web), `kokoroNative` (Android, sherpa-onnx). Auto-default: Kokoro if measured RTF < 1, else Pocket TTS if RTF < 1, else system voice. Audio cache key = hash(text + voice + speed + lexiconVersion).
- `src/tts/lexicon/` — `pharma-lexicon.json` (t½→half-life, mg/kg→milligrams per kilogram, CYP3A4→C Y P 3 A 4, μg, IC₅₀, Na⁺/K⁺-ATPase, common drug names) + user overrides table.
- `src/reader/` — Reflow view (all formats) + PDF page view toggle; read-along highlight by sentence id; tap sentence = play from there.
- `src/study/` — highlights, notes, bookmarks, cards (cloze / Q&A from highlight), FSRS review screen.
- `src/syllabus/` — `nmc-md-pharm.json` topic tree (topic names only), edit UI, tagging, progress.
- `src/ai/` — BYO key settings (base URL, key, model stored locally), "make cards / summarize selection" actions.
- `src/backup/` — export/import zip (DB JSON + optional book files).

## Milestones (each ends with a runnable, tested build)
1. Scaffold Vite/React/TS + PWA + Capacitor Android debug APK.
2. Library + import (PDF text, EPUB, DOCX, TXT) → sentence model; reflow reader.
3. System TTS + read-along sentence highlight + engine interface.
4. Neural engines: model download manager; Pocket TTS worker (streaming); Kokoro worker (streaming + pre-render queue); audio cache; engine selector + RTF benchmark auto-default; native Kokoro plugin for Android. Before coding: 10-min listening test of Pocket vs Kokoro vs OS premium voice on pharma sentences on user's own phone.
5. Pharma lexicon + user editor.
6. PDF page view with highlight boxes + view toggle.
7. Highlights / notes / bookmarks.
8. Flashcards + FSRS review.
9. NMC syllabus map + tagging + progress.
10. BYO-key AI (cards/summaries from selection).
11. Backup export/import; Play Store release build; PWA deploy.

Later (v2+): iOS, Windows (Tauri), local LLM (RAM-gated), OCR for scanned PDFs, cloud sync, native Pocket TTS on Android if WebView Pocket too slow, drug quick-lookup.

## Verification
- Vitest unit tests: lexicon expansion, sentence segmentation, extractor output per format (small fixture files), FSRS scheduling, cache-key stability, backup round-trip.
- Playwright e2e on PWA: import fixture PDF/EPUB → play system TTS → highlight advances → make card → review.
- Real-device check on one budget + one mid Android: measure Kokoro real-time factor, confirm auto-default picks system voice when RTF > 1, confirm pre-render runs in background and cached replay is instant.
- Lighthouse PWA installability + offline load.
