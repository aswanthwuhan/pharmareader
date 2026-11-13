# PharmaReader

**[Open PharmaReader](https://aswanthwuhan.github.io/pharmareader/)** · [Downloads](https://github.com/aswanthwuhan/pharmareader/releases) · [About the creator and other tools](https://github.com/aswanthwuhan/aswanthwuhan)

Offline-first PWA for MD Pharmacology study: import your own PDF/EPUB/DOCX/text, read with
listen-along TTS, highlight, and review FSRS flashcards mapped to the NMC syllabus. Files,
highlights and cards live in IndexedDB only — no accounts, no backend. GPL-3.0.
Version 0.3.10: Android (Capacitor), Windows (Tauri) and installable PWA. See `CHANGELOG.md`.

## Who it is for

- MD Pharmacology residents in India working through the NMC curriculum.
- MBBS and pharmacy students revising pharmacology.
- Anyone who wants their own textbooks read aloud offline.

## Features

- Import your own PDF, EPUB, DOCX, TXT/Markdown and web articles, or paste text.
- Listen with on-device neural voices (Kokoro-82M and Pocket TTS) or the system voice.
- Follow word-by-word highlighting while it reads; an optional on-device Whisper aligner makes it precise.
- Hear drug names and medical terms correctly through a pharmacology pronunciation lexicon.
- Save highlights, notes and bookmarks, and turn them into FSRS flashcards.
- Map chapters and cards to the NMC MD Pharmacology syllabus, editable with per-topic progress.
- Keep reading with the screen off, with lock-screen controls and a sleep timer.
- Work fully offline. Files, highlights and cards stay in IndexedDB, with no account and no server.
- Run on Android, Windows and as an installable PWA.

## Download / install

**Android (APK).** Download the latest APK from [Releases](https://github.com/aswanthwuhan/pharmareader/releases) and open it. Android 8.0 or newer with WebView 110+ is required; allow installs from your browser or file manager when asked. Build and signing notes are in [docs/ANDROID.md](docs/ANDROID.md).

**Windows (installer).** Download the Windows installer (`PharmaReader_*_x64-setup.exe`) from [Releases](https://github.com/aswanthwuhan/pharmareader/releases) and run it. It installs per user with no admin prompt. The build is unsigned, so SmartScreen may show "Windows protected your PC": choose **More info → Run anyway**. It needs WebView2, which is already on Windows 10 and 11. Details are in [docs/WINDOWS.md](docs/WINDOWS.md).

**PWA.** Open [aswanthwuhan.github.io/pharmareader](https://aswanthwuhan.github.io/pharmareader/) and install it from the browser. On Android Chrome use ⋮ → **Install app**. On iPhone or iPad use Share → **Add to Home Screen**. On desktop use the install icon in the address bar. Details are in [docs/PWA.md](docs/PWA.md).

## Privacy

Imported files, highlights, notes and cards are stored in IndexedDB on your device. There is no server and no account. Backup export is the only copy, so export one before changing device.

## FAQ

**Is there a free app that reads pharmacology PDFs aloud offline?**

Yes. PharmaReader is free and open source under GPL-3.0, and reading and speech run on your device. The voice model files download once, then work without a connection.

**Do I need an account or an internet connection?**

No account. After the one-time voice model download, the app works offline.

**Which devices does it run on?**

Android 8.0+, Windows 10 and 11, and as an installable PWA in Chrome, Edge or Safari on iPhone and iPad.

**Does it work with scanned PDFs?**

Not yet. A scanned PDF imports but has no readable text because there is no OCR, and the app says so at import.

Study aid only, not medical advice.

## Build from source

```sh
pnpm install   then:   pnpm dev    (dev server)   pnpm test   (vitest)   pnpm build   (typecheck + bundle)
```

## Credits

- **Contributors:** see [CONTRIBUTORS.md](CONTRIBUTORS.md).
- **Built with AI agents:** planned and orchestrated by Claude (Anthropic, Claude Opus); most code
  written, reviewed and tested by DeepSeek V4.1 Flash agents (DeepSeek), run through DeepSeek Harness.
  UI reference screens generated with Google Stitch.
- **Voices:** Pocket TTS by Kyutai (weights CC-BY-4.0) · Kokoro-82M by hexgrad (Apache-2.0) via
  sherpa-onnx (Apache-2.0, bundles espeak-ng GPL-3.0).
- **Reading font:** Literata (SIL OFL 1.1).
- **Syllabus:** topic map based on the NMC "Guidelines for Competency Based Postgraduate Training
  Programme for MD in Pharmacology" (2022); editable, not an official copy.
