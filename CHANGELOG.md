# Changelog

## 0.1.1 — 2026-11-09
Tested end to end on an Android emulator (clean install, offline) and in desktop Chrome.

**Fixes**
- Android: system voice was silent (Capacitor plugin proxy treated as a promise); app could not see the phone's TTS engine on Android 11+.
- Android: Kokoro download failed after 334 MB with `NoClassDefFoundError` (missing commons-io) — issue #1. Download now resumes, checks free space, warns on mobile data, and shows the failing stage with "Copy error details". Minimum Android is now 8.0.
- Pocket TTS played only the first sentence (later ones were silent); reader ignored downloaded models after restart.
- PDF paragraphs no longer break on every line; two-column papers keep column order.
- Model downloads in the Android app no longer go through the native bridge (large downloads broke).

**New**
- Warning banners when the chosen voice model isn't downloaded, a tip when none is installed, and an error when the phone has no TTS engine.
- Redesigned UI (design system with Literata reading font; reader, review, settings aligned to Google Stitch reference designs); reader hides the bottom nav.
- Pronunciation lexicon 244 → 475 rules (units, chemistry, statistics, dosing, pharmacogenomics, 30 drug respellings); fixes capital "A" read as "uh".
- Windows desktop app (Tauri) and GitHub Pages PWA.

## 0.1.0 — 2026-11-09
First working build (PWA + Android debug APK). Everything runs on the device.

- Import PDF (text), EPUB, DOCX, TXT/MD, web articles, pasted text; two-column PDF reading order.
- Reader: text view + PDF page view, read-along sentence highlight, tap-to-play, lock-screen controls, chapter pre-render.
- Voices: system voice, Pocket TTS (in-app), Kokoro (in-browser on web, native sherpa-onnx on Android); one-time model download, speed test, auto engine pick.
- Pharma pronunciation lexicon (244 rules) with user rules.
- Highlights, notes, bookmarks; FSRS flashcards; Markdown and Anki CSV export.
- NMC MD Pharmacology syllabus map (26 domains / 237 topics), editable, per-topic progress.
- Optional bring-your-own-key AI (cards, summaries).
- Backup export/import (zip).
