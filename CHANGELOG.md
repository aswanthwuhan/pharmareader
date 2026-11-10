# Changelog

## 0.3.0 — 2026-11-10
From a full audit of 0.2.0 (data safety first). Installs over 0.2.0 without losing data.

**Fixed — your data**
- Restoring a backup failed for any library with a PDF ("invalid … kind"); backups now restore every block type, and 0.2.0 backups still load.
- Export did nothing on Android (no file was saved while the app said "Exported"). Backups, notes and Anki cards now save to Documents/PharmaReader, and the message says where.
- Re-analysing a PDF's layout could delete highlights and bookmarks and move your place; it now keeps every highlight and bookmark, remaps your position, and runs as one transaction.
- Backups are written per book (no single giant file); a second export the same day no longer overwrites the first.
- Notes and the AI key are no longer included in Google's automatic Android backup.
- Undo a flashcard rating; a clock set back no longer crashes the review screen; a double tap no longer records two reviews.
- Your reading position is saved the moment it changes, not 0.7 s later.

**Fixed — listening**
- The Android back key goes back (closes the open sheet, then returns to the Library) and asks "Exit PharmaReader?" instead of closing the app.
- Reading continues with the screen locked: a foreground playback service with lock-screen and notification controls; unplugging headphones pauses.
- Brackets: the default is now a short pause around the aside ("system, ANS, controls") instead of "in brackets … close bracket".
- Model downloads keep going, and keep showing progress, when you leave Settings; a Kokoro download already running is picked up instead of reported as an error.
- Whisper word alignment no longer fails after a while (unbounded backlog, broken session reused).
- Word highlight works on sentences rendered ahead; the audio cache no longer re-reads itself on every sentence and survives lexicon updates.
- PDF layout: reading order fixed for two- and three-column pages, wide margins and stray text; the layout used is saved per book; the layout model no longer leaks memory on a failed page.

**New**
- Full-screen reading (hides the system bars on Android) and a PDF Page view that fills the screen, with Fit page in full screen.
- "Prepare ahead": choose how many sentences are rendered ahead (2–50, default 10).
- "What's new" after each update (offline). Optional update check (off by default; asks GitHub once a day when you turn it on in Settings → About).
- Settings reorganised into collapsible groups; Library book actions sheet.
- Continue listening from the Library, sleep timer (10/20/30 min or end of chapter), backup reminder, Storage panel.
- Pronunciation: rows the Android Kokoro model already says right are no longer respelled there (70 words); plurals and possessives follow their word's respelling.
- Larger touch targets (48 px) in the reader, review and backup screens.

**Known limits**
- Still debug-signed (so it updates over 0.2.0). Release signing is prepared; see docs/ANDROID.md before switching, it needs a backup and reinstall.
- Library loading still reads every book in full; large libraries open slowly (next release).

## 0.2.0 — 2026-11-10
Release-gated on an Android 16 emulator with the factory WebView 134 (clean install, upgrade from 0.1.1, offline, 5 cold starts).

**Fixed**
- Tapping a sentence then pressing Next skipped the tapped sentence (the cursor moved before audio existed).
- PDF import crashed on Android WebView < 137 (`toHex is not a function`); now pdf.js legacy build + polyfill. Minimum WebView 110.
- Imported files could read back as 0 bytes after an app update; the app now stores its own copy.
- Upgrades could keep running the previous version's code (stale service worker); cleared on launch.
- Cold-start freeze (ANR) and Page view opening tiny.

**New**
- On-device PDF layout detection (PP-DocLayout-L int8, 32 MB, optional): tables, figures, captions, formulas, headers/footers, footnotes, references. Re-analyse older books.
- Settings → Reading aloud: skip tables / figures & charts / captions / formulas / headers & footers / footnotes / references / citations; brackets "Say 'in brackets'" (default), read, or skip; paragraph pause.
- Word-by-word highlighting; optional on-device Whisper aligner (42 MB) makes it precise.
- Play a selected chunk (Continue / Replay after), Prev/Next page buttons, Play starts from the page you are on, "Generating sentence N…" progress.
- First audio much sooner (long sentences split at clauses): Kokoro ~1.7 s, Pocket ~3–5 s on the emulator.
- Pronunciation: "Ch 39" → "Chapter 39"; 32 medical respellings (hypo/hyperglycaemia family…); 166 drug/term respellings from a 6,000-term MeSH + WHO-EML screen checked with Kokoro + Whisper.

**Known limits**
- JPEG2000/JBIG2 images in some PDFs show blank in Page view (text unaffected).
- GPU acceleration is not available on Android today (see docs/PERFORMANCE.md).

## 0.1.2 — 2026-11-09
- Medical pronunciation: 32 new rules (`med-` group) for words every TTS engine mangled — hypo/hyperglycaemia, -kalaemia, -natraemia, -calcaemia, hepatomegaly, pyelonephritis, gynaecomastia, empyema, epididymitis, hemiplegia and more. Each was checked by speaking it through Kokoro and Windows voices and transcribing with Whisper; respellings that made any engine worse were dropped.

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
