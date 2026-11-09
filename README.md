# PharmaReader

Offline-first PWA for MD Pharmacology study: import your own PDF/EPUB/DOCX/text, read with
listen-along TTS, highlight, and review FSRS flashcards mapped to the NMC syllabus. Files,
highlights and cards live in IndexedDB only — no accounts, no backend. GPL-3.0.
Milestone 1 (scaffold) — see `docs/PLAN.md` for scope.

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
