# Regex portability (iOS 15.4–16.3)

Every `pattern` in `pharma-lexicon.json` must compile on the oldest WebView in the
support matrix. Lookbehind (`(?<=…)`, `(?<!…)`) is the one construct that does not: Safari
only parses it from **16.4** (see `src/tts/capabilities.ts:21`), so on iOS 15.4–16.3
`new RegExp(pattern, 'g')` throws. `regexFor()` (`src/tts/lexicon/index.ts:209`) catches
that and returns `null`, and `applyEntry()` (`src/tts/lexicon/index.ts:223`) then returns
the text unchanged — the row is dropped **silently**, and the notation is read as written:
"mug slash m two slash day" instead of "micrograms per square meter per day".

Those are exactly the devices that fall back to the system voice, so the notation rows
matter there most. In v0.3.8, 30 rows used a lookbehind and were skipped on them:

| rows | what the lookbehind guarded | rewrite |
|---|---|---|
| `b-245`, `b-251`, `b-252`, `b-253`, `b-5`, `b-13`, `b-18`, `b-19`, `b-20` | `(?<![A-Za-z])` — the unit is not glued to the end of a word | `(^\|[^A-Za-z])` + `$1` |
| `b-169` | `(?<!q)` — a `q`-prefixed dose (`q6h`) is not read as "6 hours" | `(^\|[^q])(\d)` + `$1$2` |
| `b-171`…`b-190` | `(?<![\d.])` — the `1` is not the tail of `21` or `1.1` | `(^\|[^\d.])(1)` + `$1$2` |

No ids changed and no row was added. The guard test is
`describe('regex portability (iOS 15.4–16.3)')` in `index.test.ts`: it fails if any pattern
contains `(?<`, and it re-checks that every row compiles.

## The rewrite convention

A leading `(?<!X)` becomes `(^|[^X])`, the replacement is prefixed with `$1`, and every
later `$n` shifts up by one. `applyEntry()` uses `String.prototype.replace` with a string
replacement, so `$1` is a real backreference (the plain-text path uses `split`/`join` and
is unaffected).

Two traps, both hit here:

* **A backreference followed by a literal digit.** `b-171`…`b-190` start their replacement
  with the literal `1` ("1 milligram"), so a bare `$1` would give `$11 milligram`. Today
  the spec saves that by falling back to `$1` + `"1"` when group 11 does not exist — but
  that changes meaning the day the pattern gains an eleventh group. Capture the literal
  and re-emit it instead: `(^|[^\d.])(1)\s+milligrams\b` → `$1$2 milligram`. `b-169`
  does the same with its digit (`(^|[^q])(\d)\s?h\b` → `$1$2 hours`), which also keeps the
  guard character in the output.
* **A match that starts where the previous match ended.** A lookbehind can still see the
  boundary character there; a capture group cannot, because the previous match consumed
  it. That only bites when the match can *end* on a non-word character, which is true for
  one row here (`b-13`, unit ends in `m²`/`m2`) and only for unit expressions butted
  together with no separator at all — `µg/m²µg/m²`, which no text contains. The old
  output there was `micrograms per square metermicrograms per square meter` (two phrases
  jammed with no space), i.e. already unusable; the new output leaves the second unit as
  written. Reproducing it exactly is not expressible without lookbehind, and a companion
  row ("micrograms per square meter" + unit) fixes pairs but still misses runs of three,
  so none was shipped. Every other row ends on a letter or a `\b`, where the boundary
  character is never consumed.

Lookaheads (`(?!…)`, `(?=…)`) are fine — they are not the problem and stay in use
(`b-13`, `b-247`, `b-248`, …).

## How the rewrite was verified

`.tmp/ios-lexicon/equiv.mjs` (scratch, gitignored) runs the old row and the new row over

1. every string literal in `index.test.ts` (1,583),
2. strings generated from each row's own tokens — unit spellings, digits, `/`, `µ`/`μ`,
   spaces, tabs, punctuation, letters — once with a separator between tokens (10,101
   letter / 10,720 digit / 5,850 q inputs) and once butted together with none
   (5,001 / 5,232 / 3,328),
3. a seeded fuzz over each row's own alphabet (600 strings per row),

and then the whole `expand()` pipeline (all 671 rows, file order, term word map) over the
same corpora. The pipeline replica in the harness reproduces **486/486** of the test
file's own `[input, want]` pairs, which is what makes it trustworthy as an oracle.

| measurement | count | differences |
|---|---|---|
| row-level, separator between tokens | 376,649 | **0** |
| row-level, zero-separator adjacency | 152,977 | 15 — all `b-13`, all the jammed-old class above |
| `expand()` pipeline, realistic strings | 441,836 | **0** |
| `expand()` pipeline, adjacency strings | 59,873 | 3 — same `b-13` class |

`npx vitest run src/tts/lexicon --maxWorkers=4` → 754 passed; `npx tsc -b` → clean.

If a future row needs a boundary check, use `(^|[^X])` + `$1` — and run the harness again
before shipping.
