# AGENTS.md — Kokoro TTS lexicon (pronunciation) work

This file is for the next agent. It records what the pronunciation/lexicon work was,
how it was measured, what shipped, and what is still missing. Read it before touching
`src/tts/lexicon/`.

## TL;DR

- **Two front ends.** On Android, Kokoro runs in sherpa-onnx, which looks a word up in the
  model's `lexicon-us-en.txt` first and only uses eSpeak for unknown words. Rows whose word
  that lexicon already says correctly are listed in `src/tts/lexicon/kokoro-native-known.json`
  and skipped for native Kokoro (`expand(text, 'kokoro')` on native). Measure Android
  pronunciation against that lexicon, not eSpeak.
- On the web, Kokoro's front end is **eSpeak NG** (`phonemizer@1.2.1`, the WASM build). The system
  `espeak-ng.exe` 1.52.0 with `-v en-us` produces **byte-identical IPA** — verified.
  That is the ground truth for every decision below.
- The lexicon is `src/tts/lexicon/pharma-lexicon.json`: whole-word respellings that
  rewrite a word into a spelling eSpeak reads correctly, applied by
  `src/tts/lexicon/index.ts` before synthesis.
- **Round 3** screened the OCR'd pharmacology books and added **143 rows**
  (`term-24`…`term-166`), on top of the 23 rows a concurrent session had committed.
  Lexicon is now **671 entries** (447 `b-`, 30 `rx-`, 32 `med-`, 162 `term-`; 4 plural rows retired in v0.3.0 when `expand()` learned plurals and possessives).
- Everything is verified at the **phoneme level**. The Kokoro+Whisper A/B harness
  could not run here (see *Environment gotchas*), so the new rows have IPA evidence,
  not transcript evidence.
- The lexicon changes are committed as **`95153dc`** ("143 more Kokoro respellings
  (term-24..166)"). A concurrent session committed them; this `AGENTS.md` is new and
  still untracked. Run `git log --oneline` before assuming the working tree is yours.

## The lexicon architecture

`src/tts/lexicon/index.ts` seeds the JSON into IndexedDB and applies it in file order:

| group | id | what it is | how it runs |
|---|---|---|---|
| core | `b-*` | notation → words (`t½`→`half-life`, `CYP3A4`→`C Y P three eigh four`) | ordered regex |
| drug | `rx-*` | drug-name respellings (the `-ine` defect) | ordered regex |
| medical | `med-*` | Greek/Latin morphology (`hypo-`/`hyper-`+`-emia`, `-rrhea`, `-megaly`, …) | ordered regex |
| term | `term-*` | the screened word list | **one `Map` pass** over word tokens |

Only `term-` rows whose pattern is exactly `\b[Xx]word\b` are compiled into the map;
anything else runs as a regex row. The map is why the group can hold thousands of rows
without a per-row regex pass (the 50 KB test is ~20 ms, budget 50 ms).

**One rule per word.** A word covered by `rx-`/`med-`/`term-` must not get a second row.

**No lookbehind in patterns.** iOS 15.4–16.3 cannot compile `(?<!…)`/`(?<=…)`, and
`regexFor()` silently skips a row that fails to compile. Use a `(^|[^X])` capture and
re-emit it with `$1` (see `regex-portability.md`); the test *regex portability (iOS 15.4–16.3)* enforces it.

## Measuring pronunciation

The exact front end, from a script (pnpm keeps `phonemizer` out of the top-level
`node_modules`, so import it by path):

```js
import { phonemize } from '../../node_modules/.pnpm/phonemizer@1.2.1/node_modules/phonemizer/dist/phonemizer.js';
await phonemize('omeprazole', 'en-us'); // ['ˈoʊmpɹɐzˌoʊl']
```

Or the system CLI, which is identical and much faster for batches (one call, split the
output on whitespace — espeak puts no spaces inside a word):

```
& "C:\Program Files\eSpeak NG\espeak-ng.exe" --ipa -q -v en-us -f words.txt
```

Scratch workbench (in `.tmp/lexicon-books/`, gitignored):

```
node .tmp/lexicon-books/respell.mjs <word> [candidate ...]   # IPA of a word + candidates
node .tmp/lexicon-books/check-words.mjs <word> [...]         # IPA of many words
```

## The book-screening pipeline (reproducible)

Source: `C:\Pharmacology Book\ocr` — 395 OCR'd `.md` files (KD Tripathi 8e + exam
banks), 496 313 words, 32 661 distinct tokens.

```
extract.mjs   tokenise every .md, count, drop markdown/images      -> vocab.json
screen.mjs    phonemise 13 373 pure-alphabetic candidates
              (count >= 2, 4-30 chars) -> flagged.json, with the
              known failure families as flags
fix-ine.mjs   generate -ine candidates, score against the target
              (original IPA with final /aɪn/ -> /iːn/), keep the best
verify-entries.mjs  re-phonemise every proposal; fail if the final
              vowel is not /iːn/ or the row is not a single token
```

The flags are deliberately noisy (common English trips the cluster/stress heuristics),
so **every row was read by hand** before it shipped.

## Respelling conventions (do not break these)

- **Plain English chunk spelling only.** No SSML, no IPA, no engine syntax. It must read
  the same in eSpeak NG (Kokoro), SAPI and Google TTS.
- **One lowercase token** for `term-` rows: `^[a-z]+$`, no spaces, no hyphens. The test
  enforces it.
- **Never hyphenate.** `hypo-gly-see-mia` makes eSpeak stress every chunk and read a
  final `-a` as the letter name. A single token keeps one stress.
- **`oh` = /oʊ/, `eh` = /eɪ/, `uh` = /uː/.** Only `oh` was safe in the measured rows.
- **A bare capital `A` is read as the article** (/ə/, "uh"). Write letter runs dotted
  (`A.C.E`, `H.L.A.B`) or a lone A as `eigh` (`p eigh two`, `GABA eigh`).
- **Do not add a syllable the engine then stresses**, and do not move primary stress to
  the final syllable. The picker rejects candidates that do.
- **Add the vowel, do not delete the consonant.** `-ine` → `-een`; if eSpeak also drops
  a stem vowel, add an `e` (`tyrosine` → `tyroseene`) or double a consonant
  (`fludarabine` → `fludarabbeen`).
- **A respelling must measurably improve the IPA.** If no candidate is clearly better,
  leave the word alone.

## What shipped in Round 3

143 rows, `term-24`…`term-166`. The full evidence table (word → respelling → IPA before
→ after) is in `src/tts/lexicon/term-respellings.md` § *Round 3*.

1. **The `-ine` family (~99 rows).** espeak reads a final `-ine` as /aɪn/
   ("nife-di-PINE") where the standard is /iːn/ ("nife-di-peen"). The existing `rx-`
   rows fixed 30 drug names; the books contain ~100 more (`doxycycline`, `tetracycline`,
   `tyrosine`, `adenosine`, `capecitabine`, `quetiapine`, `oxcarbazepine`, …).
   This cannot be a suffix rule: `-ine` is also the ending of `line`, `combine`,
   `decline`, `caffeine`, `machine`, so a blanket rule would respell common English.
2. **Greek `ch` and `th`** — `cholangitis→kolangitis`, `subarachnoid→subaraknoid`,
   `trichomonas→trikomonas`, `cinchona→sinkona`, `chelate→keelate`,
   `artemether→artemethir`, `arteether→arteethir`.
3. **Other** — `ascites→asytees`, `nausea→nauzia`, `epinephrine→epinephrin`,
   `levodopa→leevodopa`, `antigen→antegen`, `thrombocytopenia→thrombosyteopenia`,
   `pralidoxime→pralidokseme`, `bleomycin→bleeohmycin`, …

Three background agents swept the top 800 book words and the `drug:`/`med:`-flagged
families in parallel; 18 of their proposals were accepted after re-verification.

## What is still wrong

Measured failures with no single-token fix (see the *Still wrong* table in
`term-respellings.md`): `norepinephrine`, `furosemide`, `metronidazole`,
`levetiracetam`, `artesunate`, `oseltamivir`, `pyrazinamide`, `hydrochlorothiazide`,
`linezolid`, `sorafenib`, `vemurafenib`, `medroxyprogesterone`, `thiazolidinediones`.
Every candidate either regressed or produced a different wrong word.

Also still open:

- **Plurals.** Fixed in v0.3.0: the term pass strips `’s`, `'s` or `s` (words ≥5 letters) and respells the stem.
- **The `-afenib` family** (`sorafenib`, `regorafenib`, `dabrafenib`, `vemurafenib`)
  drops the middle syllable and every respelling keeps the /eɪ/ diphthong.
- **Agent proposals dropped as not clearly better:** `mellitus` (correct is /aɪ/,
  every candidate gives /iː/ or /eɪ/), `elisa`, `rifampicin`, `angioedema`,
  `hemangioma`, `isoniazid`.
- **More books.** Only `C:\Pharmacology Book\ocr` was screened. Point the pipeline at
  any additional OCR and re-run.

## Environment gotchas

- **Hugging Face is unreachable** from this machine. The Kokoro A/B harness
  (Kokoro-82M → Whisper → transcript) needs the Kokoro tokenizer, which is not in the
  HF cache, so it cannot run. The phoneme-level check is the best available evidence.
- **The system is under constant load** from the user's own services (DeepSeek harness,
  codex-router, opencode-browser, …). `npx vitest run` can fail to start workers or flake
  the 50 KB performance test; `npx vitest run --maxWorkers=4` is reliable.
- **Concurrent sessions commit to this repo without notice.** While this work was in
  progress another session committed `14462c6` (23 MeSH/WHO-EML rows, now `term-1`…
  `term-23`), two unrelated fixes, and finally our own lexicon work as `95153dc`. Build
  on top of those commits; do not revert them. Re-run `git log --oneline` and
  `git status` before editing, and expect the tree to move under you.
- **`.tmp/` is gitignored** — the scratch scripts and JSON are not shipped.
- **Do not kill** the long-running `node.exe` processes (`billion-context`,
  `codex-router`, `opencode-subagent-mcp`); they belong to the user.

## Files

| path | what |
|---|---|
| `src/tts/lexicon/pharma-lexicon.json` | the shipped lexicon (671 rows) |
| `src/tts/lexicon/index.ts` | seeding + `expand()` + the word map |
| `src/tts/lexicon/index.test.ts` | 754 tests; spoken/untouched corpora + performance |
| `src/tts/lexicon/drug-respellings.md` | `rx-` conventions and measured rows |
| `src/tts/lexicon/medical-respellings.md` | `med-` morphology rules |
| `src/tts/lexicon/term-respellings.md` | `term-` provenance + Round 3 evidence table |
| `.tmp/lexicon-books/` | scratch: extractor, screener, workbench, agent outputs |
