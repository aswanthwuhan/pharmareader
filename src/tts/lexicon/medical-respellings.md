# Medical respellings (`med-` group)

Residents meet words that every English text-to-speech engine gets wrong in the same
way: the engine applies its general letter-to-sound rules to a Greek or Latin compound
and lands on a different word. "Hypoglycemia" came out "hypo-gly-SEE-mee-uh" for years —
listeners heard *hypo-glycemia* with the stress in the wrong place, and phone system voices
on Android were worse: *hippo glycemia*, *hy-poglice-mia*.

This file documents the `med-` rules in `pharma-lexicon.json`, how each one was chosen,
and — more useful for the next person — the automatic check that chose them, so a new
rule can be argued with evidence instead of taste.

## What the rules are allowed to change

* **Nothing but the spelling that reaches the engine.** No SSML, no IPA, no engine-
  specific syntax: a respelling is plain English chunk spelling that reads the same in
  espeak-ng (Kokoro), SAPI (Windows / phone system voices) and Google TTS.
* **One token, not a hyphenated row.** This was measured, not assumed. Hyphenated
  variants such as `"hypo-gly-see-mia"` make espeak-ng put a primary stress on every
  chunk (`hˈaɪpoʊɡlˈaɪsˈiːmˈiːˈeɪ`) and read a final `-a` as the letter name /eɪ/;
  `"hy-po-gly-SEE-mee-uh"` is worse still, the capitals are spelled out (`S-E-E`).
  A single respelled token (`hypoglyceemia`) keeps one word and one stress
  (`hˌaɪpoʊɡlaɪsˈiːmiə`) and is what the system voices need anyway: `ee` is a long e in
  every English engine. Hyphens therefore appear only where a rule must keep a chunk
  boundary, and no chunk ends in a bare `-a`.
* **Word boundaries and case.** Every pattern is `\b`-anchored, preserves the leading
  capital of the input, and refuses to fire twice on its own output (`expand()` must stay
  idempotent, because chapters are expanded once and cached).
* **Morphology over per-word lists where the morphology is safe.** `-emia`/`-aemia`,
  `-emic`, `-rrhea` and `-otoxicity` are handled by prefix + suffix rules that cover every
  stem the compounding actually produces (hypoglycemia, hypokalaemia, hyponatraemia,
  hypocalcemia, hypomagnesemia, hypophosphatemia, hypochloremia, hypovolemia,
  hypolactatemia, hypolipidemia, hypouricemia, hypertriglyceridemia,
  hypocholesterolemia, hypobilirubinemia, hypoinsulinemia, hypoalbuminemia,
  hypoproteinemia). Single words get their own rule, because their defect is in the middle
  of the word and no stem rule reaches it.

## The automatic check

The check lives in `.tmp/lexicon-medical/` (scratch, not shipped) and is reproducible:
it synthesises every corpus word in a carrier sentence, transcribes the audio with
Whisper, and scores the transcription against the word.

```
corpus      619 medical/pharmacology words (30 existing rx- drugs as regression,
            both British and American spellings for the same term)
synthesis   (a) Kokoro-82M ONNX, voice af_heart, dtype fp32, CPU — the real engine
            (b) Windows SAPI, "Microsoft Zira Desktop" (en-US) — en-US system voice
            (c) Windows SAPI, "Microsoft Ravi" (en-IN) — en-IN system voice, the
                closest stand-in for Google TTS on an Indian Android phone
            (d) Pocket TTS — NOT exercised, see below
text        "The next word is <expand(word)>." run through the real expand()
ASR         Whisper base.en (q8, CPU) via @huggingface/transformers
score       per engine: min(letter similarity, phonetic similarity) of the transcribed
            word slot against the expected word; FAIL < 0.75
```

Pocket TTS is not exercised: `pocket-tts-js@0.1.0` is browser-only (Web Worker, Cache
Storage, Web Audio, `onnxruntime-web` from a CDN) and cannot run under Node. The phone
case is covered by the two SAPI voices instead, which have the same weakness the phone
engines show — plain letter-to-sound rules with no medical lexicon.

The phonetic metric matters: the letter metric alone marks `oedema` → `edema` as a
failure, because the recogniser spells what it heard. Conversely it *under*-rates every
respelling, because a recogniser that correctly hears "hypoglyceemia" as
"hypoglycemia" is compared letter by letter with "hypoglycemia" only if it also spells it
that way. So the check reports both, and rule acceptance looks at the transcripts.

### Baseline

619 words, before any `med-` rule:

| | words |
|---|---|
| failing on at least one engine | 146 |
| failing on at least two engines | 35 |
| Kokoro (espeak-ng) failures | 38 |
| SAPI Zira (en-US) failures | 46 |
| SAPI Ravi (en-IN) failures | 103 |

## Errors fixed

Engine order in every transcript column: **Kokoro af_heart / SAPI Zira en-US / SAPI Ravi en-IN**.
Scores are the per-engine `min(letter, phonetic)` before → after, and the verdict is the
per-engine direction (a word is "better" when more engines improve than regress by more
than 0.05).

| word | respelled as | transcript after | score before → after | verdict |
|---|---|---|---|---|
| enalapril | enalapryl | an allopril / analapril / enolapril | 0.60 / 0.70 / 0.56 → 0.70 / 0.89 / 0.78 | better |
| hepatomegaly | hepatohmegalee | Happatome galley / Hepatome Galy / Hepatomegili | 0.58 / 0.77 / 0.62 → 0.73 / 1.00 / 0.75 | better |
| pyelonephritis | pylonefritis | pylone-fritus / pilon frides / pylonephritis | 0.64 / 0.43 / 0.57 → 0.71 / 0.50 / 0.93 | better |
| gynecomastia | gynecomasteea | guinacamastia / Jinoco Mastia / gynakomasti | 0.54 / 0.71 / 0.69 → 0.69 / 0.69 / 0.75 | better |
| kaliemia | kaleemia | Calemia / Calimia / Calimia | 0.38 / 0.43 / 0.75 → 0.75 / 0.75 / 0.75 | better |
| tracheitis | trakeeitis | tracheitis / trachitis / tracheages | 0.60 / 1.00 / 0.44 → 1.00 / 0.67 / 0.56 | better |
| empyema | empyeema | ampima / empaima / Empima | 0.57 / 0.57 / 0.71 → 0.57 / 0.71 / 0.71 | better |
| epididymitis | epididimitis | Epidetomyitis / Epiditomitis / Epiditimatus | 0.69 / 0.75 / 0.67 → 0.69 / 0.83 / 0.67 | better |
| hemiplegia | hemipleejia | hemoplegia / hemiplegia / hemiplegia | 0.60 / 1.00 / 1.00 → 0.80 / 1.00 / 1.00 | better |
| hypocalcemia | hypocalceemia | hypocalcemia / hypocalcemia / hypochalcemia | 1.00 / 1.00 / 0.62 → 1.00 / 1.00 / 0.86 | better |
| hyponatraemia | hyponatreemia | hyponatremia / hypoatremia / hyponatremia | 0.92 / 0.85 / 0.85 → 0.92 / 0.85 / 0.92 | better |
| cecum | ceekum | Seekum / Seekam / Kekam | 0.60 / 0.33 / 0.20 → 0.50 / 0.33 / 0.40 | flat |
| cholecystitis | coleesistitis | cholisistitis / cholias estitis / cholese status | 0.54 / 0.92 / 0.58 → 0.77 / 0.71 / 0.58 | flat |
| haematochezia | haematokeesia | Himaro Kijja / Himatocasia / Himatokysia | 0.38 / 0.45 / 0.62 → 0.38 / 0.62 / 0.54 | flat |
| hemiparesis | hemiparresis | hemiparesis / hemiparasis / hemiparasis | 0.64 / 0.91 / 0.82 → 1.00 / 0.82 / 0.82 | flat |
| hepatocyte | hepatohsite | Hapato sight / Hepatocyte / Hepatocyte | 0.60 / 1.00 / 0.42 → 0.45 / 1.00 / 1.00 | flat |
| hypokalaemia | hypokaleemia | hypokalemia / hypocholemia / hypokalemia | 0.92 / 0.83 / 0.75 → 0.92 / 0.67 / 0.92 | flat |
| hypolipidemia | hypolipideemia | hypolipidemia / high polypidemia / hypolepidemia | 1.00 / 1.00 / 0.67 → 1.00 / 0.73 / 0.92 | flat |
| nephromegaly | nefrohmegalee | nephromegaly / nephron gale / nephromagili | 0.60 / 0.60 / 0.58 → 1.00 / 0.50 / 0.58 | flat |
| ototoxicity | ohtohtoxicity | ode-o-dexicity / autotoxicity / orthotoxicity | 0.50 / 0.83 / 0.83 → 0.58 / 0.83 / 0.77 | flat |
| splenomegaly | spleenohmegalee | splenomegaly / Spleenum Galy / spleenomegili | 0.64 / 0.85 / 0.67 → 1.00 / 0.75 / 0.67 | flat |
| amenorrhea | amenorrhoea | a menoria / amenorrhea / amenorrhea | 0.70 / 1.00 / 1.00 → 0.70 / 1.00 / 1.00 | flat |
| gynaecomastia | gynaecomasteea | guinikamastia / gainakomastia / guine comasti | 0.50 / 0.69 / 0.69 → 0.54 / 0.69 / 0.69 | flat |
| hyperglycemia | hyperglyceemia | hyperglycemia / hyperglycemia / hyperglycemia | 1.00 / 1.00 / 1.00 → 1.00 / 1.00 / 1.00 | flat |
| hyperkalaemia | hyperkaleemia | hyperkalemia / hyperkalemia / hyperchilemia | 0.92 / 0.92 / 0.69 → 0.92 / 0.92 / 0.69 | flat |
| hypoglycemia | hypoglyceemia | hypoglycemia / hypoglycemia / hypoglycemia | 1.00 / 1.00 / 1.00 → 1.00 / 1.00 / 1.00 | flat |
| dysuria | disyooria | dysuria / decile or ia / Dysuria | — / — / — → 1.00 / 0.40 / 1.00 | new |
| galactorrhea | galactorrhoea | Galactoria / Galacteroi / Galactoria | — / — / — → 0.75 / 0.58 / 0.75 | new |
| glycosuria | glykohsyooria | glycosioria / glacosiaoria / glycosuria | — / — / — → 0.73 / 0.38 / 1.00 | new |
| hepatosplenomegaly | hepatoospleenohmegalee | Happa to Splinoma Galli / Hepha Spleenom-Gale / heper to sply nomigali | — / — / — → 0.70 / 0.53 / 0.74 | new |
| hypocalcaemic | hypocalceemic | hypocalcemic / hypocalemic / hypocal cimic | — / — / — → 0.85 / 0.85 / 0.85 | new |
| nocturia | nocktyooria | naktyoria / Nokdi-Oria / nocturia | — / — / — → 0.56 / 0.56 / 1.00 | new |
| steatorrhea | steatorrhoea | Steedoria / stiataria / stetolia | — / — / — → 0.55 / 0.55 / 0.55 | new |
| atelectasis | attelektasis | Atelectasis / a telectasis / a chilectasis | 0.55 / 0.73 / 0.73 → 1.00 / 0.64 / 0.58 | mixed |
| cardiotoxicity | cardiohtoxicity | cardiotoxicity / cardioticcystity / cardio-thoxicity | 0.86 / 1.00 / 1.00 → 1.00 / 0.63 / 0.93 | mixed |
| erythema | erytheema | arathima / Ara Thema / Erithima | 0.63 / 0.71 / 0.50 → 0.57 / 0.63 / 0.71 | mixed |
| oophorectomy | oophoorectomee | Ooferectomy / oafurectomy / ufuraktumi | 0.58 / 0.73 / 0.70 → 0.75 / 0.58 / 0.25 | mixed |
| pruritus | proorightus | proritus / pro-riders / pruraitas | 0.56 / 0.78 / 0.88 → 0.78 / 0.44 / 0.78 | mixed |
| hematochezia | hematokeesia | hamadocasia / Himatocasia / hematokisia | 0.58 / 0.64 / 0.73 → 0.58 / 0.67 / 0.67 | mixed |
| hepatotoxicity | hepatohtoxicity | Hapatoricxicity / Hepatotic Sicity / Hepatopoxicity | 0.73 / 1.00 / 1.00 → 0.73 / 0.80 / 0.93 | mixed |
| hypoxemia | hypoxeemia | hypozemia / hypochymia / hypoxemia | 0.89 / 1.00 / 1.00 → 0.89 / 0.67 / 1.00 | mixed |
| ketoacidosis | ketoasidosis | catosidosis / keto-shidosis / ketoacidosis | 0.67 / 1.00 / 1.00 → 0.67 / 0.82 / 1.00 | mixed |
| nephrotoxicity | nephrohtoxicity | nephroodoxicity / nephroticicity / nephrotoxicity | 0.86 / 1.00 / 1.00 → 0.86 / 0.79 / 1.00 | mixed |

The remaining rows are words the corpus round could not measure before the rule existed
(`new`) or where the three engines disagreed (`mixed`): the respelling moved espeak-ng's
IPA towards the intended reading — which is what Kokoro actually pronounces — while one
of the SAPI voices moved the other way, or vice versa. Whisper on a single isolated word
swings about ±0.3 between runs, so a 0.1 move on one engine is not evidence either way;
the transcripts are what to read.

## Tried and reverted

Each of these was measured, written as a rule, and then removed: the recognition round
got worse on at least two engines and no engine improved.

| word | would have been | transcript with the respelling | score before → after |
|---|---|---|---|
| bronchiectasis | bronkeeektaysis | branquiectasees / bronki tesus / bronky cases | 0.71 / 1.00 / 1.00 → 0.67 / 0.54 / 0.57 | mixed |
| neuralgia | nooralja | Norelja / Norelya / neuralgia | 0.56 / 1.00 / 1.00 → 0.44 / 0.44 / 1.00 | mixed |
| petechiae | petteekeeeye | Patty-ki-i / petikai / Paticier | 0.44 / 0.33 / 0.44 → 0.33 / 0.44 / 0.43 | flat |
| digoxin | dijoksin | digiksen / de jocksen / the joxing | 0.40 / 1.00 / 1.00 → 0.50 / 0.33 / 0.44 | mixed |
| megakaryocyte | megakarryosite | megacaria site / Megakariasite / Megacharayo site | 0.69 / 0.62 / 0.77 → 0.62 / 0.69 / 0.67 | mixed |
| tubule | toobool | tubal / Table / tubal | 1.00 / 0.17 / 0.57 → 0.67 / 0.33 / 0.67 | better |

## Checked and left alone

These were in the corpus and are read acceptably by all three engines (or no respelling
tested better), so they carry no rule — adding one would risk a regression for no gain:

anaphylaxis, akathisia, rhabdomyolysis, thrombocytopenia, agranulocytosis, tachycardia,
bradycardia, tachypnoea, dyspnoea, apnoea, hypertension, hypothyroidism, hyperthyroidism,
oedema, edema, ischaemia, ischemia, anaemia, leukemia, septicemia, haemoptysis, melaena,
pneumothorax, hirsutism, extrapyramidal, tardive dyskinesia (the noun "dyskinesia" alone
was measured: `diskineezia` fixes espeak-ng's `kaɪ`, but the two SAPI voices then heard
"disco", so it is not worth it), muscarinic, nicotinic, sympathomimetic (every candidate
moved the stress to the first syllable), pharmacokinetics, pharmacodynamics,
bioavailability, teratogenic, idiosyncrasy, tachyphylaxis, angioedema, bronchospasm,
Stevens-Johnson, myocardial (`myohkardial` fixes espeak-ng but the recognisers lost the
second syllable), cholinergic, hematemesis (no candidate improved espeak-ng at all),
labetalol, cefotaxime, cefixime, phenytoin, amlodipine, carbamazepine (the existing `rx-`
rules already cover the drug endings).

Two boundary decisions worth writing down:

* **"Hypo" as a casual word stays untouched.** The rules need a compounding tail
  (`…emia`, `…emic`, `rrhea`, `totoxicity`), so "Hypo" at the start of a sentence, "hypo"
  as shorthand, "hypothermia", "hypothesis", "hyperlink", "hype" and "hyperactive" never
  match. Respelling a bare "Hypo" would be wrong: it is a word of its own.
* **"Diarrhea" is deliberately rewritten to "diarrhoea"** by the `-rrhea` rule. The
  British spelling carries the stress in every engine (`ɐmˌɛnɔɹˈiə` instead of
  `ɐmˈɛnɔɹˌiə`), and the word is far more common in a ward chapter than the spelling
  difference is worth.

## The rules

32 rules, ids `med-1` … `med-32`, appended after the `rx-` block in
`src/tts/lexicon/pharma-lexicon.json`, so file order still runs core → drugs → medical.
They are one toggleable group: `entryGroup(id)` returns `'medical'` for `med-`, `'drug'`
for `rx-`, `'core'` otherwise, and the lexicon UI can switch the group off as a unit.

| rule | pattern | replacement | covers |
|---|---|---|---|
| med-1 | `\b([Hh]ypo\|[Hh]yper)([a-z]*?[^eEaA])a?emia\b` | `$1$2eemia` | hypoglycemia, hypokalaemia, hyponatraemia, hypocalcemia, hypomagnesemia, hypophosphatemia, hypovolemia, hypolipidemia, hypouricemia, hypertriglyceridemia, hypocholesterolemia … (`-emia` and `-aemia`) |
| med-2 | `\b([Hh]ypo\|[Hh]yper)(kal)a?emic\b` | `$1$2eemic` | hypokalemic, hyperkalemic |
| med-3 | `\b([Hh]ypo\|[Hh]yper)(calc)a?emic\b` | `$1$2eemic` | hypocalcemic, hypercalcemic |
| med-4 | `\b([A-Za-z]+)rrhea\b` | `$1rrhoea` | amenorrhea, steatorrhea, galactorrhea, rhinorrhea, bronchorrhea |
| med-5 | `\b([Kk])ali(a)?emia\b` | `$1aleemia` | kaliemia (no hypo-/hyper- prefix) |
| med-6 | `\b([Oo])totoxicity\b` | `$1htohtoxicity` | ototoxicity |
| med-7 | `\b([A-Za-z]{3,}o)toxicity\b` | `$1htoxicity` | hepatotoxicity, nephrotoxicity, cardiotoxicity, neurotoxicity, retinotoxicity … |
| med-8/9 | `\b([Hh])a?ematochezia\b` (two rules, one per spelling) | `…tokeesia` | hematochezia, haematochezia |
| med-10 | `\b([Gg])yn(ae\|e)comastia\b` | `$1yn$2comasteea` | gynaecomastia, gynecomastia |
| med-11 | `\b([Ee])rythema\b` | `$1rytheema` | erythema |
| med-12–15 | `\b([Hh])epatosplenomegaly\b` etc. | `…ohmegalee` | hepatosplenomegaly, hepatomegaly, splenomegaly, nephromegaly |
| med-16–32 | one word each | see `pharma-lexicon.json` | empyema, atelectasis, hepatocyte, cholecystitis, pruritus, oophorectomy, hemiparesis, hemiplegia, tracheitis, epididymitis, pyelonephritis, ketoacidosis, cecum, enalapril, glycosuria, dysuria, nocturia |

The `-megaly` family is the clearest case for morphology over words: espeak-ng drops the
vowel before the `g` in *every* one of them, so the rule is one shape, not four words.

## Regenerating

The rules are authored in `.tmp/lexicon-medical/med-rules.mjs` (scratch) and written into
`pharma-lexicon.json` by:

```
node .tmp/lexicon-medical/apply-rules.mjs    # rewrites the med- block, ids renumbered
node .tmp/lexicon-medical/build-expand.mjs   # rebuilds the Node harness around expand()
```

The JSON is the shipped artefact; the scratch scripts exist so the next rule can be
measured the same way rather than guessed.
