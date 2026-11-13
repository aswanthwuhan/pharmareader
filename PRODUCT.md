# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

<!-- Shipped through a Capacitor Android shell and a Tauri Windows shell, both of which
     render this same web UI. The design language stays web-native (see init.md: a native
     wrapper around a website does not make its design language native); Android insets,
     the hardware back gesture and 48dp minimum touch sizing are still honoured inside it. -->

## Users

MD Pharmacology residents in India — postgraduate doctors reading their own textbooks,
notes and downloaded articles for their MD coursework and exams. Primary user is a single
resident on her own phone.

Knowing it is one person's device shapes everything: no multi-user affordances, no account
chrome, no sharing or social surfaces. Import once, then study for months.

Secondary contexts, same person, same data: a laptop at a desk (Windows app or the installed
PWA) for longer reading, and a tablet for revision.

## Product Purpose

A resident already owns the material — textbook PDFs, lecture notes, downloaded articles,
her department's reading list. PharmaReader turns those files into one study system: read
them comfortably, listen to them hands-free with on-device voices, and hold on to what they
say with highlights, notes and spaced-repetition cards organised against the NMC syllabus.

Success is behavioural, not cosmetic: she reaches for the same app in the ten-minute gaps of
a ward day — the walk back from rounds, the wait before a seminar — instead of reading once
and losing it. Retention is the point; the reading surface is how she gets there.

## Positioning

Everything that makes the material *studiable* runs on the device: text extraction, sentence
segmentation, a pharma pronunciation lexicon, neural voices, FSRS scheduling, and the NMC
topic map. No account, no server, no upload — a resident can study in a hospital basement
with no signal, on a phone that is not the latest model.

A neighbouring reader can copy the font and the layout. It cannot truthfully claim the offline
pipeline (Kokoro / Pocket TTS running at CPU speed with a measured real-time factor, cached
audio, a lexicon that says "t½" as "half-life"), because that is engineering, not styling.

## Operating Context

- Import happens in one sitting, usually once, from files already on the phone or laptop:
  text PDF, EPUB, DOCX, TXT/MD, or a web article (URL where CORS allows, else pasted text).
- Studying is phone-first, one-handed, and often interrupted. Sessions are minutes, not hours.
- Listening is the primary mode in transit: screen off or phone in a pocket, pick up the
  sentence where she left off.
- Lighting varies wildly — bright outpatient daylight to a dark hostel room at midnight. Both
  light and dark themes are first-class, and dark is used for real reading, not as a setting.
- Data lives in IndexedDB on that device. Backup export/import is the only durability story
  and the only thing that makes a device swap survivable.
- Network may be absent for days. Anything that silently requires a fetch is a bug.
- Storage is finite: imported books, downloaded voice models (~90 MB q8 / ~320 MB fp32) and
  rendered audio share the same budget on a mid-range phone.
- Accessibility here is long-session legibility: reading in poor light, at speed, with the
  phone at arm's length, sometimes while walking.

## Capabilities and Constraints

Confirmed functionality (all shipping or planned in docs/PLAN.md, not aspirational copy):

- Library of imported books and articles; per-book progress; delete.
- Reflow reader for every format, plus a PDF page view with highlight boxes.
- Read-along sentence highlight; tap a sentence to hear it from there.
- Highlight, note, bookmark; cloze/Q&A cards from highlights; FSRS review.
- NMC MD Pharmacology topic tree (Basic / Intermediate / Advanced), editable; chapters and
  cards tagged to topics; per-topic progress.
- On-device TTS engine selection (system voice / Pocket TTS / Kokoro worker / native Kokoro),
  pronunciation lexicon with user overrides, audio cache.
- BYO-key AI summaries/cards, off by default.
- Backup export/import as a zip.

Constraints that design work must respect:

- No backend, no accounts, no telemetry. Any state that matters must survive a reload.
- No OCR yet: a scanned PDF imports but yields no readable text. The app must say so
  plainly at import time instead of failing silently.
- GPL-3.0 project; bundled fonts and models must carry compatible licences.
- Offline means no webfont CDN at runtime: type must come from the system or from files
  shipped inside the app.
- Terminology is fixed and used verbatim: Library, Reader, Review, Syllabus, Settings;
  Highlight, Note, Bookmark, Card, Topic; "On-device voice models".
- Explicitly undecided / out of scope for v1: iOS, cloud sync, OCR, drug quick-lookup.

## Brand Commitments

- Name: PharmaReader. It is a tool that takes her seriously; the name is the product.
- Binding visual constraint carried in from the incumbent app: the teal identity colour
  `#0f4c5c`, already used as the app accent, icon background and manifest theme.
- Voice in copy: plain, specific, second person, no exclamation marks, no exclamation of
  delight, no "seamless"/"effortless"/"AI-powered" marketing register. Numbers where numbers
  exist (format, chapter count, percent read, model size).
- The audience is doctors: legibility, precision and calm outrank novelty every time. The
  app should look like something a resident would keep on the home screen beside UptoDate.

## Evidence on Hand

- Working app with real importers and fixtures: `src/import/__fixtures__/notes-on-nursing.epub`
  and companion PDF/TXT/DOCX fixtures; tests in `src/import/*.test.ts`.
- Real NMC topic data: `src/syllabus/nmc-md-pharm.json` (topic names only).
- Real lexicon: `src/tts/lexicon/pharma-lexicon.json`.
- No marketing claims, testimonials, customer logos, benchmark screenshots or press exist,
  and none may be invented. Any performance number shown in UI must come from a live
  measurement in that session (e.g. measured real-time factor), never a hardcoded promise.

## Product Principles

1. **The text is the interface.** Chrome, colour and motion exist to get her to the words and
   out of the way again. If a decoration does not help her read, find, or remember, it goes.
2. **Quiet competence over persuasion.** No sign-up or marketing carousel (the one guided tour points at real controls, can be skipped, and is replayable from Settings → About), no upsell, no celebration
   confetti. Show the state of things accurately and let her act.
3. **Say what is true, including what failed.** "Looks scanned — OCR not supported yet" beats
   a spinner that never resolves. Errors name the file and the reason.
4. **Offline is the default state, not a degraded one.** Every surface must be complete
   without a network: no skeleton that waits on a fetch, no remote asset, no dependency on a
   CDN.
5. **Respect the long sitting.** Type, measure, contrast, and both themes are tuned for hours
   of reading, not for a screenshot. Touch targets fit a thumb, and nothing shifts under it.

## Accessibility & Inclusion

- WCAG 2.2 AA is the floor for both themes: body text ≥ 4.5:1, large text ≥ 3:1, UI borders
  and focus rings ≥ 3:1 against their own background.
- Touch targets ≥ 44×44 CSS px (48dp in the Android shell), with ≥ 8px between adjacent ones.
- Full keyboard operation, visible focus ring on every interactive element, and no
  colour-only state (format, progress, warning all carry text or shape as well as hue).
- Respects `prefers-color-scheme` and `prefers-reduced-motion`; no motion that cannot be
  switched off by that media query, no parallax, no autoplay audio.
- Text resizes to 200% without loss of content or function; the reading surface must not
  clip when the OS font scale is raised.
- Semantic structure: one `h1` per page, landmarks (`main`, `nav`), labelled controls, live
  regions for import status and errors.

## Assumptions and Open Decisions

No user interview was available for this record (delegated implementation worker, brief
explicitly states the user cannot be asked). Everything below was inferred from docs/PLAN.md,
the existing code, and the delegated brief; it is recorded as an assumption, not as a
confirmed answer, and should be corrected by the user where wrong.

- *Inferred:* the single resident is the only user; no shared device, no classroom mode.
- *Inferred:* listening (hands-free) is at least as common as on-screen reading.
- *Inferred:* Hindi/English mixed study material is normal, but the UI ships English only and
  the reading type must set Latin script well first.
- *Inferred:* the phone is mid-range Android, possibly two years old, so animation and blur
  budgets stay small.
- *Open:* whether a dark theme should follow the system or be user-selectable in Settings.
  Until decided, it follows `prefers-color-scheme`.
- *Open:* whether the Windows/laptop surface gets a persistent side navigation or keeps the
  phone layout in a centred column. The design system supports the side rail; the decision
  is recorded in DESIGN.md as the current default.
