# Changelog

## 0.4.0 — 2026-11-13
Android, Windows and the web app. Installs over 0.3.x without losing data.

**New — a guided tour**
- A first-time tour lights up each real control and says what it does: importing, the player, Text and Page view, highlights and cards, voices, PDF layout and backup. Skip it any time; replay it from Settings → About → How to use PharmaReader.

**Changed — the reader gives the page the screen**
- The player is one row (speed, previous, play, next, position, more) and the PDF page controls are one row under the page. On a small phone the page gets about half as much height again, and runs edge to edge.
- A PDF now opens on the printed page. Text is one tap away, and the choice is remembered per book.
- The Library lists your books first; tips and reminders sit below them. Sheets stay inside the reading column on wide screens.
- Small-phone fixes across the app: touch targets under 44 px, controls set too close together, a Syllabus menu that ran off short screens, and loading spinners that froze with reduced motion on.

**Changed — the read-along highlight no longer covers the words**
- The sentence being read has a light wash with no box around it, and the word being spoken is a stronger band of the same colour. Page view now marks the spoken word too.
- You choose the colour, fill or underline, and the strength of both, in Aa in the reader or Settings → Reading aloud.

**Changed — Kokoro is the recommended voice**
- The voice button in the reader offers Kokoro without leaving the book: one download, then it works offline, and it takes over from the next sentence. The app asks once on the first Play; the phone voice keeps reading if you say not now.
- Settings → Voice shows the voices of the selected engine only. Kokoro voices can be tested and one set as the default there.
- On iPhone and iPad the app warns that the phone voice may not start and recommends Kokoro where the device can run it.

**New — PDF layout detection, asked at import**
- Importing a PDF asks what kind it is. Textbook or complex pages uses layout detection so columns and tables are read in order (the model downloads once if needed); Simple book skips it.
- Settings → PDF layout can run layout detection on any PDF already in the Library.

**New — save audio for several chapters**
- Playback options → Save audio for more… queues several chapters, or a page range in a PDF, to be rendered ahead and kept for offline play. Chapters already saved with the current voice are marked.

## 0.3.10 — 2026-11-13
Web app only (GitHub Pages). Installs over 0.3.9 without losing data.

**Fixed — phone voice on iPhone**
- Play could switch to Pause and then stay silent on iPhone. The app cleared the speech queue right before speaking even when nothing was queued, and Safari on iOS can drop a sentence sent straight after that. It now clears the queue only when something is actually playing.

## 0.3.9 — 2026-11-13
Web app mostly (GitHub Pages); Android gets the import, backup and PDF fixes too. Installs over 0.3.8 without losing data.

**Fixed — PDFs in Page view**
- On iPhone, Page view showed the page as a tiny stamp — on smaller iPhones a few pixels wide, so it looked like no PDF at all. On a phone the page now fills the width and scrolls; tablets and the "Fit page" button still show the whole sheet. In Page view the voice tip and, on short screens, the chapter buttons step aside (chapters stay in Contents).
- Scanned PDFs: pages that are one big JPEG 2000 or JBIG2 image (most scanned textbooks) were drawn blank because the image decoders were never loaded. They now draw, offline too, with correct colours for CMYK pages.

**Fixed — iPhone and iPad (Safari)**
- Safari deletes a website's books, highlights and flashcards after 7 days without a visit unless it is on the Home Screen. The Library now says so once, with how to add it; Settings → Storage repeats it.
- Importing a very large PDF could close Safari. An import now keeps one copy of the file in memory instead of three, and files over 500 MB are refused with a clear message on iPhone and iPad. Backups are built and restored with less memory too.
- On iOS 15.4–16.3, dose units such as µg/kg/min and "1 milligram" were read out wrongly; they are read properly again.
- The on-device voices (Kokoro, Pocket) need iOS 16.4 or newer; on older iPhones they are shown as unavailable instead of failing after a large download. On iPhone they carry a memory note, and word-by-word highlighting is off by default there (it uses about 100 MB).
- If iOS refuses to resume after a pause, the reader stays on the sentence and says "Tap Play to continue" instead of stopping silently.
- Landscape on small iPhones: the player is one compact row, so the text is no longer hidden behind it. Smaller fixes for older Safari colours, scrolling behind open sheets and the copy button in AI actions.

## 0.3.8 — 2026-11-13
Web app only (GitHub Pages). Installs over 0.3.7 without losing data.

**Fixed — iPhone and iPad (Safari)**
- On iOS 16.3 and older the app never started: the page stayed on "Loading the study app". It now starts on iOS 15.4 and newer (iPhone 6s, 7 and the first SE included).
- On iOS 16.4 to 17.3 every PDF page was blank in the reader, although the text imported. Pages draw again.
- The first tap on Play with the phone's built-in voice could stay silent on iPhone. It now speaks on the first tap.
- "Add to Home Screen" now shows the PharmaReader icon instead of a screenshot of the page, and the installed app opens without Safari's address bar.

## 0.3.7 — 2026-11-11
Web app only (GitHub Pages). Installs over 0.3.6 without losing data.

**Fixed — Kokoro in the browser reads whole sentences again, in a clear voice**
- 0.3.6 read in short bursts of a few words with a stop after each. Sentences are spoken in one flow again.
- The whisper is fixed at its cause. On a graphics card (WebGPU), Kokoro's voice turned breathy partway through a sentence because the card computes one step of the voice wrongly on long sentences. The downloaded model is now corrected once, on this device, the first time Kokoro loads (a few seconds, no new download), and long sentences stay clear to the last word — the same as Kokoro without a graphics card.
- Sentences prepared with 0.3.6 are made again once.

## 0.3.6 — 2026-11-11
Web app only (GitHub Pages). Installs over 0.3.5 without losing data.

**Fixed — the voice no longer turns into a whisper**
- Kokoro in the browser on a graphics card (WebGPU) no longer fades into a breathy whisper partway through a long sentence. It now voices a sentence in shorter pieces, so it stays clear to the last word. Kokoro without a graphics card, and on Android, was not affected.
- The Pocket voice no longer changes towards the end of a sentence. A long clause was cut mid-word and its last words were spoken as a separate take after a short gap; clauses are now short enough to be spoken in one go.
- Sentences that were already prepared with these voices are made again once, so the old clips are replaced.

## 0.3.5 — 2026-11-11
Installs over 0.3.4 without losing data.

**Fixed — long sentences**
- The end of a long sentence no longer trails off, turns into a whisper or goes missing. Kokoro in the browser, Kokoro on Android and the Pocket voice now voice a long sentence in pieces and join them, so the whole sentence is heard.
- Sentences that were already prepared are made again once, so the old cut-off clips are replaced.

**Changed — Kokoro back to the full model**
- Android uses the full 334 MB Kokoro model again. The lighter INT8 model from 0.3.3 is gone because it did not sound right.
- A phone that has only the INT8 files downloads the full model once, with progress. **Remove the old INT8 download (126 MB)** then frees the space.
- Threads: 2 by default, 1 for a cooler phone, 4 with a warning that the phone gets warmer.
- Kokoro in the browser is the full fp32 model only. The q8 and fp16 options are removed.

**New — a voice picker and Test voice for every voice model**
- The phone voice, Kokoro in the browser, Pocket and Kokoro on Android each have their own voice list, and a **Test voice** button that speaks a short sample with that voice at the current speed.
- Android Kokoro voices have readable names instead of file names, and Pocket's voices are listed before the model is downloaded.

## 0.3.4 — 2026-11-11
Installs over 0.3.3 without losing data.

**Fixed — two-column PDFs**
- Shaded boxes and panels that span both columns (Katzung's "Example" boxes, for instance) are now read whole, between the text above and the text below, instead of the voice jumping back and forth between the columns.
- Equations and their numbers, like "(9)", are read where they are printed, not at the end of a column.
- A table that fills the page is read row by row.
- The column gutter is learned once for the whole book instead of page by page, so the order no longer changes from page to page.

**New — per-book column setting**
- Library → a book's More actions → **Columns**: Auto, One column or Two columns. Changing it re-reads the book, and the setting is kept in backups.

**New — PDF page view Layout button**
- **Layout** shows the page as numbered boxes in reading order, so you can see how the text will be read.
- **Fix order**: tap the blocks in the order you want them read, then Save.

**Fixed — browser voices**
- The Kokoro and Pocket voices failed to load in the browser ("Cannot read properties of undefined (reading 'prepare')" and "(reading 'ensure')").
- Kokoro in the browser now defaults to the full-quality fp32 model (about 320 MB). The small q8 model sounded garbled and is labelled lower quality. Clips are re-made after switching.
- Your chosen Kokoro or Pocket voice is now the one you hear. When a phone voice was also set, these voices fell back to their first voice, and after changing voice, sentences already prepared kept playing in the old one. On Android, the downloaded Kokoro voice also uses the speaker you picked. Sentences already prepared with a downloaded voice are prepared once more after this update.

## 0.3.3 — 2026-11-11
Installs over 0.3.2 without losing data.

**New — a cooler on-device voice (Android)**
- A lighter INT8 Kokoro model: a 126 MB download instead of 334 MB, and about a third of the memory. Same voices. Settings → On-device voice models → Kokoro offers it; your current voice keeps working until the new one has played once, and only then can the old 334 MB files be deleted.
- Threads: 2 by default (recommended), 1 for the coolest phone, 4 with a warning that the phone gets warmer.

**Fixed — heat while listening**
- Pausing no longer keeps preparing sentences in the background.
- "Prepare ahead" defaults to 3 sentences instead of 10.
- With word highlighting off, or the screen off, the word-alignment model no longer runs; the word timer checks 15 times a second instead of 60.
- A warning when word highlighting runs next to a downloaded voice, since the two together keep the phone busy.

**Fixed — PDF page view**
- The whole page fits the screen, the view follows the sentence being read, and the highlight is clearly visible in dark mode.
- "Fit width" has its own icon, so it is no longer mistaken for the Full screen button.

**Fixed — browser**
- The Kokoro voice failed to load in the browser ("Cannot read properties of undefined (reading 'onnx')").

## 0.3.2 — 2026-11-11
Installs over 0.3.1 without losing data.

**Fixed — PDF layout model**
- An import could wait at "Analysing layout" for ever when the phone stopped the model in the background. A page now gives up after 90 seconds, loading after 60, and the import carries on with the text layout.
- When the downloaded model cannot start, or fails on some pages, the import now says so and why, and the re-analyse summary ends with the reason. Before, the book was quietly read with the text layout.
- A paragraph the model boxed in with a picture is read as text instead of being skipped with the figure; the labels inside a diagram are still skipped.

## 0.3.1 — 2026-11-11
Installs over 0.3.0 without losing data.

**Fixed — phone screen**
- The Library ran off the side of the phone when a book with a long title was the one to continue: every screen now stays inside the window, at any text size.
- With a book to continue, "Continue" is the one filled button and Import steps back; the progress percentage is a readable size; the backup reminder link is a full-size tap target.

**Fixed — PDF text**
- Words ran together wherever the type changed to italic or bold ("studiedin vivoinduced", "Thefirst"); the space is kept.
- A sentence that ran from the foot of one column to the top of the next was cut in two; it is read as one sentence.
- Ordinary sentences that open with a figure or table number ("Figure 3 shows…") were treated as captions and skipped by the voice.
- A long one-line running head is no longer read as body text.
- One page the layout model cannot read no longer switches the model off for the rest of the book.

Already imported PDFs keep their old text: use Settings → PDF layout → Advanced → Re-analyse, or import the file again.

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
