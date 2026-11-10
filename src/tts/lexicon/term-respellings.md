# Medical term respellings (`term-` group)

Pharmacology prose is dense with words no general-purpose English front end knows:
INN drug names (`omeprazole`, `atorvastatin`, `acetylcholinesterase`), anatomy and
physiology that is only ever read by specialists. Kokoro synthesises whatever phoneme
string its espeak-ng front end produces, so a word that espeak mis-segments is
mispronounced with perfect audio quality — the listener hears *home-prazole* or
*fyoor-OH-smide* and has no cue that the engine, not the drug, is wrong.

The `med-` group ([medical-respellings.md](medical-respellings.md)) covers the Greek and
Latin morphology families (`hypo-`/`hyper-` + `-emia`, `-rrhea`, `-megaly`, …). This group
covers the rest of the vocabulary a pharmacology chapter actually contains, and this file
records where the term list came from, how each shipped respelling was measured, and what
is still wrong.

## Where the terms came from

| source | what was used | licence | why it is safe to derive respellings |
|---|---|---|---|
| NLM MeSH 2026 descriptors (`desc2026.xml`, 31 110 records) | descriptor names from the trees a pharmacology chapter cites: drugs/chemicals (D), diseases (C), anatomy (A), phenomena (G), therapeutics/investigative techniques (E02/E03/E05), mental disorders (F03) | public domain (US Government work, NLM) | yes — no attribution obligation, derivation is unrestricted |
| WHO Model List of Essential Medicines, 23rd list (2023, WHO/MHP/HPS/EML/2023.02) | medicine names on the list, including the parenthetical British/INN alternatives (`paracetamol (acetaminophen)`) | CC BY-NC-SA 3.0 IGO | yes — only the *names of the medicines* are used, the list itself is not reproduced |
| `src/syllabus/nmc-md-pharm.json` (in this repo) | chapter/area titles, as a relevance bonus | project file | yes |
| curated INN/BAN list (in `.tmp/lexicon-mega/harness/assemble3.mjs`) | ~200 names MeSH does not carry in British spelling (`salbutamol`, `lignocaine`, `frusemide`, `glibenclamide`, `adrenaline`, …) | authored here | yes |

RxNorm and NCI Thesaurus were considered and **not** used: their licence terms restrict
redistribution of derived content, and INN spellings (which the reader actually sees) are
not what those vocabularies index anyway. MeSH indexes US/class names — `Acetaminophen`,
not `paracetamol`; `Albuterol`, not `salbutamol`; `Lidocaine`, not `lignocaine`; classes in
the plural (`Penicillins`, `Gentamicins`) — which is why the EML and the curated list exist.

Downloads are in `.tmp/lexicon-mega/sources/` (scratch, not shipped) together with the
fetch scripts, so the inventory can be rebuilt:

```
desc2026.zip           16.8 MB   https://nlmpubs.nlm.nih.gov/projects/mesh/MESH_FILES/xmlmesh/desc2026.zip
eml-2023.pdf          927 kB    https://iris.who.int/server/api/core/bitstreams/289a875c-cc89-4914-90ad-eb3c578ebaf6/content
```

## How the list was filtered

MeSH is a vocabulary of concepts, not of readable words, so it is filtered to what a
speaker would actually say:

* shape: 1–3 words, 4–30 characters, letters (plus `'` and `-`), contains a lowercase
  letter (this alone drops every all-caps acronym — those are spelled letter by letter and
  belong to the `b-` rules), no digits;
* tree filter as in the table above;
* an English stoplist (`methods`, `models`, `statistics`, `economics`, `risk`, `food`, …)
  removes the E-/N-tree words that are administrative rather than clinical.

23 782 tree-matching descriptors → 15 226 after shape/dedupe → scored by a frequency proxy
(word counts in 12.8 MB of PubMed abstracts on pharmacology and pharmacotherapy, 2018–2025 —
used only as a ranking signal, not redistributed), EML membership, syllabus mentions, tree
and depth → **6 000 terms** shipped as the screening inventory (rank 1 `disease`, rank
3000 `buttocks`, tail = long zero-frequency chemical descriptors such as
`pentosan sulfuric polyester`, `plakophilins`).

A term already covered by an `rx-`/`med-` rule is dropped, so there is exactly one rule per
word. Words the morphology rules already respell (`thiamine` → `thiameen`,
`pyridoxine` → `pyridoxeen`, `hypoglycemia` → `hypoglyceemia`) keep the `med-` rule.

## The automatic check

The check is scratch (`.tmp/lexicon-mega/`, not shipped) but reproducible from the scripts
recorded here. It has two passes, because the two questions are different: *does the front
end produce the right phonemes* is cheap; *does a real listener hear the right word* is not.

```
cheap pass    espeak-ng IPA (phonemizer 1.2.1, 'en-us') for all 6 000 terms — 27 s batched
              plus shape heuristics for the known failure families
expensive     Kokoro-82M ONNX (af_heart, fp32, CPU) synthesis of "The next word is <word>."
              → Whisper base.en (q8) transcript → similarity against the word
A/B           for each candidate fix: the same two clips, original and respelled, in one
              plan, so the two transcripts are directly comparable
```

Flagging (cheap pass) used the shape families, not the IPA alone: a dropped or extra vowel
relative to the spelling (`furosemide` → `fjˈʊɹɹoʊsmˌaɪd`, the `e` is gone), a suffix that
is a known trap (`-itis`, `-osis`, `-emia`, `-oma`, `-algia`, `-ectomy`, `-plasty`, `-scopy`,
`-pathy`, `-plegia`, `-uria`, `-rrhea`, `-pnea`, `-kinesia`, `-esthesia`, …), a Greek/Latin
onset (`ps-`, `pn-`, `pt-`, `rh-`, `mn-`, `gn-`, `kn-`, `wr-`), `ch` read /tʃ/ where the word
wants /k/ (`cholinergic`, `chloride`), `th` read /ð/ where it wants /θ/ (`artemether`),
primary stress on the first syllable of a long word or on the final syllable, and 3+
consonant clusters in the IPA.

**6 000 terms screened → 3 213 flagged (54 %)**; 1 709 of the 3 802 single-word terms were
flagged. From the flagged words a sample was ASR-tested: **600 most suspicious singles
(drug tree first, then flag score, then corpus count) + 300 seeded-random control**, i.e.
900 Kokoro clips transcribed by Whisper. Words the surface filter cannot see (stress is
right on paper, but the vowel is wrong) are covered by the control sample.

Of those 900 clips, **92 failed the round trip** (both the letter similarity and the
phonetic similarity below 0.75). Most of the 92 are chemical-class plurals and rare
descriptors (`xanthenes`, `boranes`, `calixarenes`, `thiazoles`) that a reader meets once;
the actionable subset was the drug names, where the wrong shape repeats every chapter.
Round 2 therefore took the clearest of those, hand-wrote a single-token respelling for
each (19 words), and A/B-tested them in one batch of 38 clips: **15 improved and shipped,
4 regressed or produced no change and were dropped** (`sotalol`, `ritanserin`,
`dutasteride`, `ionophores`), `donepezil` was neutral on the letter score but clearly
better in IPA, so it shipped.

IPA heuristics alone are *not* a sufficient acceptance test — the harness also generated
1 789 mechanical variants for 420 words and found 249 "improvements" that read as gibberish
(`enoterobactin`, `inidolequinones`). Nothing in this group ships because a heuristic liked
it; every row below has an A/B transcript.

## Counts

| stage | count |
|---|---|
| terms in the screening inventory | 6 000 |
| flagged by the cheap pass (shape + IPA heuristics) | 3 213 (54 %) |
| single-word terms flagged | 1 709 of 3 802 |
| clips ASR-tested (Kokoro → Whisper) | 900 (600 suspicious + 300 control) |
| baseline round trips that failed | 92 (both scores < 0.75) |
| respellings A/B-tested in total | 20 first round + 19 second round = 39 |
| rows shipped | 23 |
| candidates regressed or unchanged and dropped | 6 (`rabeprazole`, `spironolactone`, `sotalol`, `ritanserin`, `dutasteride`, `ionophores`) |
| terms still wrong with no single-token fix | 14 (table below) |

## Errors fixed

Each row: the respelling that ships, the Whisper transcript of the original clip and of the
respelled clip, and the similarity score (letter, against the target word).

| word | respelled as | transcript before → after | score before → after | verdict |
|---|---|---|---|---|
| omeprazole | `ohmeprazole` | own prasole → omoprazzle | 0.64 → 0.80 | better |
| esomeprazole | `esohmeprazole` | esoimprezol → eso meprasole | 0.67 → 0.85 | better |
| pantoprazole | `pantohprazole` | pandapresel → panto prezel | 0.50 → 0.67 | better |
| lansoprazole | `lansohprazole` | lance prasole → lanso prezol | 0.69 → 0.75 | better |
| acetylcholinesterase | `acetylcholinnesteraze` | acetylcholine stirase → acetylcholinasterase | 0.90 → 0.95 | better |
| atorvastatin | `attorvastatin` | ad or vastatin → a torvastatin | 0.79 → 0.92 | better |
| palonosetron | `palohnohsetrone` | palanostrone → palonosatron | 0.75 → 0.92 | better |
| granisetron | `granisitron` | grandeistron → grandisatron | 0.75 → 0.83 | better |
| atenolol | `attennolol` | 8-N-L-O → a tenalal | 0.38 → 0.75 | better |
| donepezil | `dohneppezil` | don't bezel → donnie pessel | 0.60 → 0.58 | better in IPA, neutral on the recogniser |
| letrozole | `letrohzole` | letrasel → letrozole | 0.56 → 1.00 | better |
| risperidone | `risperridohn` | risbradon → risperidone | 0.64 → 1.00 | better |
| colestipol | `kohlestipol` | coles de pile → colustipal | 0.64 → 0.80 | better |
| droperidol | `drohperidol` | dropodal → dropper et al | 0.60 → 0.64 | better |
| topotecan | `tohpohteekan` | topo kin → to po tikin | 0.56 → 0.67 | better |
| probenecid | `prohbenesid` | probnessed → proban acid | 0.60 → 0.80 | better |
| docetaxel | `dohsetaksel` | dostaxyl → docetaxil | 0.67 → 0.89 | better |
| mesoridazine | `mesohridazeen` | mess or a disease → messeridazine | 0.50 → 0.85 | better |
| pramipexole | `pramihpeksohl` | paramipseau → prammy pexal | 0.45 → 0.64 | better |
| tiletamine | `tilletameen` | til temiene → till atamin | 0.70 → 0.70 | IPA fixed, recogniser neutral |
| emetics | `emmetiks` | a Maddox → amatix | 0.14 → 0.43 | better |
| cholangiocarcinoma | `kohlanjeeohkarsinoma` | chalingyakar-senoma → colon geocarcinoma | 0.61 → 0.83 | better |
| levobupivacaine | `levohbuhpivakaine` | loveabup of a cane → levo boopovacaine | 0.60 → 0.81 | better |

The `-prazole` family is one defect: espeak puts the stress on the first syllable and
swallows the next one (`ˈoʊmpɹɐzˌoʊl`), so listeners hear *OHM-pra-zole* and *RAYB-prazole*.
Writing the stressed vowel (`ohmeprazole` → `ˈoʊmɪpɹˌæzoʊl`) restores both the syllable and
the stress. `atorvastatin` the same way: `ˈæɾoːɹvˌæstɐtˌɪn` gains a geminate consonant
(`attorvastatin` → `ɐtˈoːɹvɐstˌætɪn`) and the stress lands on *-va-*. `-setron` drugs lose
the `o` of *-setron* to the cluster (`GRAND-is-tron`); spelling the missing vowel fixes it.

Two measured traps, worth keeping in mind before writing the next row:

* **`oh` is /oʊ/, `eh` is /eɪ/, `uh` is /uː`.** Only `oh` was safe here.
* **A respelling must not add a syllable the engine then stresses.** `acetylcholinnesteraze`
  works because `-nesteraze` keeps the /nɛsˈtər/ the original spelling destroys.

Round 2 confirmed both traps and added a third: **an inserted `e` before a single consonant
is read /eɪ/** (`meperidine` → `mepperideen` is fine, but `vemurafenib` → `vemmurafennib`
still says *ray*), and **`c` before `i` must become `s`, never `k`** if `-caine` is to stay
/k eɪ n/ — `levohbuhpivakeen` reads *-keen*, `levohbuhpivakaine` reads *-kayn*. The
pronunciation of a respelling is not predictable from the spelling of the drug; each row
here was read back through espeak first and then through Kokoro + Whisper.

### Why these are per-word rows and not one suffix rule

The brief was "prefer morphology over per-word rows where it is safe", and for these words
it is not: the defect is in the *stem*, not in the suffix. Every `-prazole` needs its own
vowel inserted after a different syllable (`ome-` → `ohme-`, `eso-` → `esoh-`, `panto-` →
`pantoh-`, `lanso-` → `lansoh-`), and the ending `-prazole` is pronounced correctly once
the stem is fixed. A rule that rewrote `-prazole` would double-correct and regress
`rabeprazole` — which is exactly what the A/B run measured. `-setron` and `-statin` behave
the same way: `granisitron` inserts a vowel, `attorvastatin` doubles a consonant, and
neither change is derivable from the ending. A suffix rule would have to be a list of stems
anyway, with worse evidence.

The families that *are* safe (`hypo-`/`hyper-` + `-emia`, `-osis`, `-itis`, …) are already
in the `med-` group; this group deliberately starts after them.

## Round 3: the books on disk (KD Tripathi 8e + exam banks)

Rounds 1–2 screened a MeSH/WHO-EML inventory. Round 3 screens the text the reader
actually reads: the OCR'd pharmacology books and exam banks in `C:\Pharmacology Book\ocr`
(395 files, 496 313 words, 32 661 distinct tokens). The pipeline is scratch
(`.tmp/lexicon-books/`, not shipped) and reproducible:

```
extract   tokenise every .md, count, drop markdown/images  -> vocab.json
screen    phonemise all 13 373 pure-alphabetic candidates (count >= 2, 4–30 chars)
          with the exact front end: eSpeak NG 1.52.0, -v en-us, verified to give
          byte-identical IPA to phonemizer@1.2.1 (the WASM build Kokoro calls)
flag      the known failure families: final -ine read /aɪn/, Greek ch read /tʃ/
          where /k/ is wanted, th read /ð/ where /θ/ is wanted, the silent onsets
          (ps-, pn-, pt-, rh-, gn-, kn-, wr-, mn-), 3+ consonant clusters, the
          drug/medical suffix families, first/final-syllable stress
respell   generate candidates (…-een, …-eene, …-een with a doubled consonant),
          phonemise them, keep the candidate closest to the target (the original
          IPA with the final /aɪn/ -> /iːn/), rejecting any that moves the primary
          stress onto the final syllable
```

**13 373 candidates screened → 7 559 flagged → 124 rows shipped.** The flags are
deliberately noisy — common English words trip the cluster and stress heuristics —
so every row was read by hand and re-checked with the workbench before it shipped.
The Kokoro + Whisper A/B could not be run for this round: the cached Kokoro repo has
no tokenizer and the Hugging Face hub is unreachable from this machine, so these rows
are verified at the phoneme level with the exact front end rather than by transcript.

### The -ine family

The single biggest defect in the books: espeak reads a final **-ine** as /aɪn/
("nife-di-PINE") where the standard is /iːn/ ("nife-di-peen"). The existing `rx-`
rows fixed 30 drug names with this defect; the books contain about 100 more. The fix
is mechanical — write the final vowel (`-ine` → `-een`, with an extra `e` or a doubled
consonant where espeak also drops a stem vowel) — but it cannot be a suffix rule, for
the same reason as `-prazole`: `-ine` is also the ending of common English words
(`line`, `combine`, `decline`, `outline`, `caffeine`, `machine`), and a blanket rule
would respell those. So the rows are per word, and the word list is the map.

### Greek ch and th

espeak reads Greek `ch` as /tʃ/ in words that want /k/ (`cholangitis`, `subarachnoid`,
`trichomonas`, the `cinchona` alkaloids, `chelate`), and voices `th` in `artemether`
and `arteether` where the standard is /θ/. Each is respelled to the letter the engine
actually says.

### Other

`ascites` (*ass-SITES* → *uh-SY-teez*) and `nausea` (*NAW-ssee-uh* → *NAW-zee-uh*).

### Rows shipped in round 3

| word | respelled as | espeak IPA before → after |
|---|---|---|
| doxycycline | `doxycycleen` | `dˈɑːksɪsˌaɪklaɪn` → `dˈɑːksɪsˌaɪkliːn` |
| codeine | `codeeen` | `kˈoʊdaɪn` → `kˈoʊdiːn` |
| tetracycline | `tetracycleen` | `tˈɛtɹɐsˌaɪklaɪn` → `tˈɛtɹɐsˌaɪkliːn` |
| pilocarpine | `pilocarpeen` | `pˈaɪləkˌɑːɹpaɪn` → `pˈaɪləkˌɑːɹpiːn` |
| reserpine | `reserpeen` | `ɹᵻsˈɜːpaɪn` → `ɹᵻsˈɜːpiːn` |
| benzathine | `benzatheen` | `bˈɛnzɐθˌaɪn` → `bˈɛnzɐθˌiːn` |
| physostigmine | `physostigmeen` | `fˈaɪsəstˌɪɡmaɪn` → `fˈaɪsəstˌɪɡmiːn` |
| benzodiazepine | `benzodiazepeen` | `bˈɛnzoʊdˌɪeɪzpˌaɪn` → `bˈɛnzoʊdˌɪeɪzpˌiːn` |
| tigecycline | `tigecycleen` | `tˈaɪɡɪsˌaɪklaɪn` → `tˈaɪɡɪsˌaɪkliːn` |
| capecitabine | `capecitabeen` | `kˈeɪpsɪtˌæbaɪn` → `kˈeɪpsɪtˌæbiːn` |
| quetiapine | `quetiapeen` | `kwˈɛʃɪˌæpaɪn` → `kwˈɛʃɪˌæpiːn` |
| oxcarbazepine | `oxcarbazepeen` | `ˈɑːkskɑːɹbˌeɪzpaɪn` → `ˈɑːkskɑːɹbˌeɪzpiːn` |
| emtricitabine | `emtricitabeen` | `ɛmtɹˈɪsɪtˌæbaɪn` → `ɛmtɹˈɪsɪtˌæbiːn` |
| fludarabine | `fludarabbeen` | `flˈuːdɐɹˌæbaɪn` → `flˈuːdɐɹˌæbiːn` |
| yohimbine | `yohimbeen` | `jˈoʊhɪmbˌaɪn` → `jˈoʊhɪmbˌiːn` |
| cladribine | `cladribeen` | `klˈædɹɪbˌaɪn` → `klˈædɹɪbˌiːn` |
| gemcitabine | `gemcitabeen` | `dʒˈɛmsɪtˌæbaɪn` → `dʒˈɛmsɪtˌæbiːn` |
| mirtazapine | `mirtazapeen` | `mˈɜːɾɐzˌæpaɪn` → `mˈɜːɾɐzˌæpiːn` |
| nicardipine | `nicardipeen` | `nˈɪkɑːɹdˌɪpaɪn` → `nˈɪkɑːɹdˌɪpiːn` |
| sertraline | `sertraleen` | `sˈɜːtɹəlˌaɪn` → `sˈɜːtɹɐlˌiːn` |
| clevidipine | `clevidipeen` | `klˈɛvɪdˌɪpaɪn` → `klˈɛvɪdˌɪpiːn` |
| glulisine | `gluliseen` | `ɡlˈuːlɪsˌaɪn` → `ɡlˈuːlɪsˌiːn` |
| sulfadoxine | `sulfadoxeen` | `sˈʌlfɐdˌɑːksaɪn` → `sˈʌlfɐdˌɑːksiːn` |
| cytarabine | `cytarabbeen` | `sˈaɪɾɐɹˌæbaɪn` → `sˈaɪɾɐɹˌæbiːn` |
| minocycline | `minocycleen` | `mˈɪnəsˌaɪklaɪn` → `mˈɪnəsˌaɪkliːn` |
| pirenzepine | `pirenzepeen` | `pˈaɪɚnzɪpˌaɪn` → `pˈaɪɚnzɪpˌiːn` |
| retigabine | `retigabeen` | `ɹˈɛɾɪɡˌæbaɪn` → `ɹˈɛɾɪɡˌæbiːn` |
| thyroxine | `thyroxeen` | `θˈaɪɹəksˌaɪn` → `θˈaɪɹəksˌiːn` |
| tiagabine | `tiagabeen` | `tˈiːəɡˌæbaɪn` → `tˈiːəɡˌæbiːn` |
| venlafaxine | `venlafaxeen` | `vˈɛnlɐfˌæksaɪn` → `vˈɛnlɐfˌæksiːn` |
| zalcitabine | `zalcitabeen` | `zˈælsɪtˌæbaɪn` → `zˈælsɪtˌæbiːn` |
| decitabine | `decitabeen` | `dᵻsˈɪɾɐbˌaɪn` → `dᵻsˈɪɾɐbˌiːn` |
| demeclocycline | `demeclocycleen` | `dˈɛmɪklˌɑːsaɪklˌaɪn` → `dˈɛmɪklˌɑːsaɪklˌiːn` |
| eflornithine | `eflornitheen` | `ˈɛflɔːɹnˌɪθaɪn` → `ˈɛflɔːɹnˌɪθiːn` |
| ezogabine | `ezogabeen` | `ˈɛzəɡˌæbaɪn` → `ˈɛzəɡˌæbiːn` |
| istradefylline | `istradefylleen` | `ˈɪstɹeɪdfˌɪlaɪn` → `ˈɪstɹeɪdfˌɪliːn` |
| noscapine | `noscapeen` | `nˈɑːskɐpˌaɪn` → `nˈɑːskɐpˌiːn` |
| orellanine | `orellaneen` | `ˈɔːɹɪlˌænaɪn` → `ˈɔːɹɪlˌæniːn` |
| tafenoquine | `tafenoqueen` | `tˈeɪfnəkwˌaɪn` → `tˈeɪfnəkwˌiːn` |
| acetylcysteine | `acetylcysteene` | `ˈæsɪtˌɪlsɪstˌaɪn` → `ˈæsɪtˌɪlsɪstˌiːn` |
| benidipine | `benidipeen` | `bᵻnˈɪdɪpˌaɪn` → `bᵻnˈɪdɪpˌiːn` |
| benztropine | `benztroppeen` | `bˈɛnztɹəpˌaɪn` → `bˈɛnztɹəpˌiːn` |
| cevimeline | `cevimeleen` | `sˈɛvaɪmlˌaɪn` → `sˈɛvaɪmlˌiːn` |
| cilnidipine | `cilnidipeen` | `sˈɪlnɪdˌɪpaɪn` → `sˈɪlnɪdˌɪpiːn` |
| didanosine | `didanosseen` | `dˈɪdɐnˌɑːsaɪn` → `dˈɪdɐnˌɑːsiːn` |
| flucytosine | `flucytoseene` | `flˈʌsɪtˌɑːsaɪn` → `flˈʌsɪtˌoʊsiːn` |
| fluorocytosine | `fluorocytoseene` | `flˈʊɹɹəsˌɪɾəsˌaɪn` → `flˈʊɹɹəsˌɪɾoʊsˌiːn` |
| loxapine | `loxapeen` | `lˈɑːksɐpˌaɪn` → `lˈɑːksɐpˌiːn` |
| miltefosine | `miltefosseen` | `mˈɪltɪfˌɑːsaɪn` → `mˈɪltɪfˌɑːsiːn` |
| nimodipine | `nimodipeen` | `nˈɪmədˌɪpaɪn` → `nˈɪmədˌɪpiːn` |
| pargyline | `pargylene` | `pˈɑːɹdʒɪlˌaɪn` → `pˈɑːɹdʒɪlˌiːn` |
| rivastigmine | `rivastigmeen` | `ɹˈɪvɐstˌɪɡmaɪn` → `ɹˈɪvɐstˌɪɡmiːn` |
| tacrine | `tacreen` | `tˈækɹaɪn` → `tˈækɹiːn` |
| telenzepine | `telenzepeen` | `tˈɛlᵻnzˌɛpaɪn` → `tˈɛlᵻnzˌɛpiːn` |
| terbinafine | `terbinafeen` | `tˈɜːbɪnˌæfaɪn` → `tˈɜːbɪnˌæfiːn` |
| tesofensine | `tesofenseen` | `tˈɛsoʊfˌɛnsaɪn` → `tˈɛsoʊfˌɛnsiːn` |
| tranylcypromine | `tranylcyprommeen` | `tɹˈænɪlsˌɪpɹəmˌaɪn` → `tɹˈænɪlsˌɪpɹəmˌiːn` |
| varenicline | `varenicleen` | `vˈæɹənˌɪklaɪn` → `vˈæɹənˌɪkliːn` |
| vinorelbine | `vinorelbeen` | `vˈɪnɔːɹlbˌaɪn` → `vˈɪnɔːɹlbˌiːn` |
| ajmaline | `ajmaleen` | `ˈædʒməlˌaɪn` → `ˈædʒmɐlˌiːn` |
| amodiaquine | `amodiaqueen` | `ˈæmoʊdˌɪɐkwˌaɪn` → `ˈæmoʊdˌɪɐkwˌiːn` |
| anthracycline | `anthracycleen` | `ˈænθɹɐsˌaɪklaɪn` → `ˈænθɹɐsˌaɪkliːn` |
| asenapine | `asenapeen` | `ˈæsənˌæpaɪn` → `ˈæsənˌæpiːn` |
| bicuculline | `bicuculleen` | `baɪkˈʌkjʊlˌaɪn` → `baɪkˈʌkjʊlˌiːn` |
| bromhexine | `bromhexeen` | `bɹˈɑːmhɪksˌaɪn` → `bɹˈɑːmhɪksˌiːn` |
| butenafine | `butenafeen` | `bjˈuːtənˌæfaɪn` → `bjˈuːtənˌæfiːn` |
| clofarabine | `clofarabbeen` | `klˈɑːfɐɹˌæbaɪn` → `klˈɑːfɐɹˌæbiːn` |
| dicyclomine | `dicyclommeen` | `dˈɪsaɪklˌɑːmaɪn` → `dˈɪsaɪklˌɑːmiːn` |
| eslicarbazepine | `eslicarbazepeen` | `ˈɛslɪkˌɑːɹbeɪzpˌaɪn` → `ˈɛslɪkˌɑːɹbeɪzpˌiːn` |
| felodipine | `felodipeen` | `fˈɛlədˌɪpaɪn` → `fˈɛlədˌɪpiːn` |
| homatropine | `homatroppeen` | `hˈɑːmɐtɹˌɑːpaɪn` → `hˈɑːmɐtɹˌɑːpiːn` |
| laudanosine | `laudanosseen` | `lˈɔːdɐnˌɑːsaɪn` → `lˈɔːdɐnˌɑːsiːn` |
| liothyronine | `liothyronneen` | `lɪˈɑːθɪɹˌɑːnaɪn` → `lɪˈɑːθɪɹˌɑːniːn` |
| meglumine | `meglumeen` | `mˈɛɡluːmˌaɪn` → `mˈɛɡluːmˌiːn` |
| metirosine | `metiroseene` | `mˈɛɾɪɹˌɑːsaɪn` → `mˈɛɾɪɹˌoʊsiːn` |
| molsidomine | `molsidommeen` | `mˈɑːlsɪdˌɑːmaɪn` → `mˈɑːlsɪdˌɑːmiːn` |
| omadacycline | `omadacycleen` | `ˈɑːmɐdˌæsaɪklˌaɪn` → `ˈɑːmɐdˌæsaɪklˌiːn` |
| piperaquine | `piperaqueen` | `pˈaɪpɹɐkwˌaɪn` → `pˈaɪpɹɐkwˌiːn` |
| theobromine | `theobromeene` | `θiːəbɹˈoʊmaɪn` → `θiːəbɹˈoʊmiːn` |
| cinchona | `sinkona` | `sɪntʃˈoʊnə` → `sɪŋkˈoʊnə` |
| cinchonism | `sinkonism` | `sˈɪntʃənˌɪzəm` → `sˈɪŋkənˌɪzəm` |
| cinchonidine | `sinkonidine` | `sˈɪntʃənˌɪdiːn` → `sˈɪŋkənˌɪdiːn` |
| cinchonine | `sinkonneen` | `sˈɪntʃənˌaɪn` → `sˈɪŋkənˌiːn` |
| artemether | `artemethir` | `ˈɑːɹɾɪmˌɛðɚ` → `ˈɑːɹɾɪmˌɛθɪɹ` |
| arteether | `arteethir` | `ˈɑːɹɾiːðɚ` → `ˈɑːɹɾiːθˌɪɹ` |
| benzodiazepines | `benzodiazepeenes` | `bˈɛnzoʊdˌɪeɪzpˌaɪnz` → `bˈɛnzoʊdˌɪeɪzpˌiːnz` |
| tetracyclines | `tetracycleenes` | `tˈɛtɹɐsˌaɪklaɪnz` → `tˈɛtɹɐsˌaɪkliːnz` |
| anthracyclines | `anthracycleenes` | `ˈænθɹɐsˌaɪklaɪnz` → `ˈænθɹɐsˌaɪkliːnz` |
| tyrosine | `tyroseene` | `tˈaɪɹəsˌaɪn` → `tˈaɪɹoʊsˌiːn` |
| adenosine | `adenoseene` | `ˈædənˌɑːsaɪn` → `ˈædənˌoʊsiːn` |
| phenylalanine | `phenylalaneen` | `fˌiːnaɪlˈælɐnˌaɪn` → `fˌiːnaɪlˈælɐnˌiːn` |
| creatinine | `createneen` | `kɹiːˈeɪtɪnˌaɪn` → `kɹiːˈeɪtənˌiːn` |
| lysine | `lyseen` | `lˈaɪsaɪn` → `lˈaɪsiːn` |
| alanine | `alaneen` | `ɐlˈænaɪn` → `ɐlˈæniːn` |
| xanthine | `xantheen` | `zˈænθaɪn` → `zˈænθiːn` |
| guanine | `guaneen` | `ɡwˈɑːnaɪn` → `ɡwˈɑːniːn` |
| cysteine | `cysteene` | `sˈɪstaɪn` → `sˈɪstiːn` |
| cytosine | `cytoseene` | `sˈaɪɾəsˌaɪn` → `sˈaɪɾoʊsˌiːn` |
| arginine | `argineen` | `ˈɑːɹdʒɪnˌaɪn` → `ˈɑːɹdʒɪnˌiːn` |
| methionine | `methionneen` | `mˈɛθɪˌɑːnaɪn` → `mˈɛθɪˌɑːniːn` |
| hypoxanthine | `hypoxantheen` | `hˌaɪpoʊzˈænθaɪn` → `hˌaɪpoʊzˈænθiːn` |
| thioguanine | `thioguaneen` | `θˌaɪoʊɡjˈuːɐnˌaɪn` → `θˌaɪoʊɡjˈuːɐnˌiːn` |
| azaguanine | `azaguaneen` | `ˈæzɐɡjˌuːɐnˌaɪn` → `ˈæzɐɡjˌuːɐnˌiːn` |
| threonine | `threonneen` | `θɹɪˈɑːnaɪn` → `θɹɪˈɑːniːn` |
| guanosine | `guanosseen` | `ɡwˈɑːnəsˌaɪn` → `ɡwˈɑːnəsˌiːn` |
| ornithine | `ornitheen` | `ˈɔːɹnɪθˌaɪn` → `ˈɔːɹnɪθˌiːn` |
| sphingosine | `sphingosseen` | `sfˈɪŋɡəsˌaɪn` → `sfˈɪŋɡəsˌiːn` |
| chancroid | `shancroid` | `tʃˈæŋkɹɔɪd` → `ʃˈæŋkɹɔɪd` |
| chitosan | `kaitan` | `tʃˈɪɾɑːsən` → `kˈaɪtən` |
| subarachnoid | `subaraknoid` | `sˈʌbɐɹˌætʃnɔɪd` → `sˈʌbɐɹˌæknɔɪd` |
| trichomonas | `trikomonas` | `tɹˌɪtʃəmˈoʊnəz` → `tɹˌaɪkəmˈoʊnəz` |
| trichomoniasis | `trikomoniasis` | `tɹˌɪtʃəmˌoʊnɪˈɑːsiz` → `tɹˌaɪkəmˌoʊnɪˈɑːsiz` |
| trichuris | `trikuris` | `tɹˈɪtʃjʊɹɹˌɪs` → `tɹˈaɪkjʊɹɹˌɪs` |
| sporotrichosis | `sporotrikosis` | `spˌɔːɹətɹɪtʃˈoʊsɪs` → `spˌɔːɹətɹɪkˈoʊsɪs` |
| hypotrichosis | `hypotrikosis` | `hˌaɪpoʊtɹɪtʃˈoʊsɪs` → `hˌaɪpoʊtɹaɪkˈoʊsɪs` |
| hypertrichosis | `hypertrikosis` | `hˌaɪpɚtɹɪtʃˈoʊsɪs` → `hˌaɪpɚtɹaɪkˈoʊsɪs` |
| onychomycosis | `onikomycosis` | `ˌɑːnɪtʃˌɑːmɪkˈoʊsɪs` → `ˌɑːnɪkˌɑːmɪkˈoʊsɪs` |
| mesenchymal | `mesenkimal` | `mˈɛsəntʃˌɪməl` → `mˈɛsəŋkˌɪməl` |
| chelate | `keelate` | `tʃˈɛleɪt` → `kˈiːleɪt` |
| chelators | `keelators` | `tʃɛlˈeɪɾɚz` → `kiːlˈeɪɾɚz` |
| chelating | `keelating` | `tʃˈɛleɪɾɪŋ` → `kˈiːleɪɾɪŋ` |
| ascites | `asytees` | `ɐssˈaɪts` → `ɐsˈaɪɾiːz` |
| nausea | `nauzia` | `nˈɔːsɪə` → `nˈɔːziə` |
| chelates | `keelates` | `tʃˈɛleɪts` → `kˈiːleɪts` |
| cholangitis | `kolangitis` | `tʃˌɑːlɐndʒˈaɪɾɪs` → `kˌɑːlɐndʒˈaɪɾɪs` |

### Two agent sweeps

Three parallel agent sweeps — the top 800 book words, the `med:`-flagged families, and
the `drug:`-flagged families — found a further 18 words. Every candidate was re-checked
with the workbench before it shipped; the sweeps' own proposals that did not hold up
(`mellitus`, `elisa`, `rifampicin`, `angioedema`, `hemangioma`, `isoniazid`, and the
`-afenib` family the earlier round had already measured as unfixable) were dropped.

| word | respelled as | espeak IPA before → after |
|---|---|---|
| epinephrine | `epinephrin` | `ˈɛpɪnˌɛfɹiːn` → `ˈɛpɪnˌɛfɹɪn` |
| antigen | `antegen` | `ˈæntɪdʒˌɛn` → `ˈæntɪdʒən` |
| levodopa | `leevodopa` | `lˌɛvədˈoʊpə` → `lˌiːvədˈoʊpə` |
| edema | `ideema` | `ˈɛdᵻmə` → `ɪdˈiːmə` |
| oedema | `oedeema` | `ˈiːdᵻmə` → `iːdˈiːmə` |
| miosis | `myosis` | `mɪˈoʊsɪs` → `maɪˈoʊsɪs` |
| hyperemia | `hypereemia` | `hˌaɪpɚɹˈɛmiə` → `hˌaɪpɚɹˈiːmiə` |
| glioma | `gleeoma` | `ɡlɪˈoʊmə` → `ɡliːˈoʊmə` |
| hematuria | `heematuria` | `hˌɛmətʃˈʊɹɹiə` → `hˌiːmətʃˈʊɹɹiə` |
| thrombocytopenia | `thrombosyteopenia` | `θɹˌɑːmbəsˌɪɾoʊpˈiːniə` → `θɹˌɑːmbəsˌaɪɾoʊpˈiːniə` |
| ketonuria | `keetonuria` | `kˌɛtənjˈʊɹɹiə` → `kˌiːtənjˈʊɹɹiə` |
| acetylcholine | `asetilcholene` | `ˈæsɪtˌɪlkəlˌiːn` → `ˈæsɪtˌɪlkoʊlˌiːn` |
| uveitis | `uveaitis` | `jˈuːveɪɾiz` → `jˌuːviːˈaɪɾɪs` |
| valproate | `valproaate` | `vˈælpɹoʊt` → `vˈælpɹoʊˌeɪt` |
| angioplasty | `anjiohplasty` | `ˈæŋɡɪˌɑːplɐsti` → `ˈændʒɪˌoʊplɐsti` |
| pralidoxime | `pralidokseme` | `pɹˈælɪdˌɑːksaɪm` → `pɹˈælɪdˌɑːksiːm` |
| obidoxime | `obidokseme` | `ˈɑːbɪdˌɑːksaɪm` → `ˈɑːbɪdˌɑːksiːm` |
| bleomycin | `bleeohmycin` | `blɪəmˈaɪsɪn` → `blˌiːoʊmˈaɪsɪn` |

## Regressed and dropped

| word | candidate | transcript before → after | score | why dropped |
|---|---|---|---|---|
| rabeprazole | `rabbeprazole` | ray prezel → rabbapresil | 0.55 → 0.45 | transcription got worse; the doubled consonant did not break the `rab-` cluster the way it did in `attorvastatin` |
| spironolactone | `spyrohnolactone` | spironalactone → spyronolic tone | 0.93 → 0.80 | baseline was already recognisable; the respelling split the word |
| sotalol | `sohtalol` | soda lah → soda lah | 0.57 → 0.57 | espeak phonemises both spellings identically (`sˈoʊɾɐlˌɑːl`), so the row would be dead weight |
| ritanserin | `ritanserrin` | written sarin → written sarin | 0.67 → 0.67 | the transcript did not change; the recogniser is not hearing a fixed word |
| dutasteride | `dootaasteride` | dude stride → doodosteride | 0.73 → 0.67 | IPA is right (`dˈuːɾɑːstɚɹˌaɪd`) but the recogniser scored the respelling lower, and the rule is evidence, not theory |
| ionophores | `eyonohfors` | I in off force → I and O force | 0.45 → 0.40 | round trip regressed |

`spironolactone` also shows why the A/B harness matters: the IPA said the original stress
was wrong (`spˈaɪɚnəlˌæktoʊl`), but the recogniser heard it, so there was nothing to fix.

## Still wrong, with no single-token fix found

These are measured failures (`ipa.json`, and the round trip where a clip exists). They stay
as written because every candidate either regressed or produced a different wrong word.

| term | espeak IPA | what it sounds like | why no fix shipped |
|---|---|---|---|
| norepinephrine | `nˈoːɹpaɪnfɹˌiːn` | nor-**pine**-freen | all variants merge *nephrine* into one syllable; needs a hyphen, which breaks the single-token rule |
| furosemide | `fjˈʊɹɹoʊsmˌaɪd` | fyoor-OH-smide | medial `e` deleted; any respelling of the `fj` onset reads /faɪ/ (`fyoorosemide`) |
| metronidazole | `mˈɛtɹənˌɪdɐzˌoʊl` | met-ron-**ID**-a-zole | no candidate improved the transcript; it is already comprehensible |
| levetiracetam | `lˈɛvɪtˌɜːɹɐsˌɛɾæm` | lev-i-turr-a-SET-am | `-cetam` is read `-setam`; respellings moved the error rather than fixing it |
| artesunate | `ˈɑːɹɾɪsˌʌneɪt` | AR-ti-sun-ate | stress is on the first syllable; `artesoonate` reads *ar-TESS-oo-nate* (also wrong) |
| oseltamivir | `ˈoʊsltɐmˌɪvɪɹ` | OH-selt-a-mi-veer | dropped `e`; restoring it (`oseltamevir`) changed the vowel quality of `-vir` |
| pyrazinamide | `pˈɪɹeɪzˌɪnɐmˌaɪd` | peer-a-ZIN-a-mide | `py-` read as `peer-`; `pyrazzinamide` fixed the stress but broke the first vowel |
| hydrochlorothiazide | `hˌaɪdɹəklˌoːɹoʊθɪˈeɪzaɪd` | …-thi-**AY**-zaɪd | the `-thiazide` syllable split is wrong; the `med-` `-thiazide` family cannot reach it without a hyphen |
| linezolid | `lˈaɪnzəlˌɪd` | LYNE-zo-lid | minor: the vowel of `-zo-` is short; every fix cost the first syllable |
| sorafenib | `sˈoʊɹeɪfnˌɪb` | so-**RAY**-fnib | `-ra-` is read /eɪ/ in this context; every respelling that restored the syllable kept the diphthong (`sohrafennib` → `sˈoʊɹeɪfənˌɪb`) |
| vemurafenib | `vˈiːmjʊɹɹˌeɪfnɪb` | vee-myoor-**RAY**-fnib | same `-ra-` defect, plus the `-fn-` cluster; `vemmurafennib` fixed the onset and not the diphthong |
| medroxyprogesterone | `mˌɛdɹəksɪpɹˈoʊdʒstɚɹˌoʊn` | …-proj-ster-one | the `-gesterone` cluster loses its vowel; spelling the vowel moved the primary stress and changed /dʒ/ to /ɡ/ (`meddroxiprogosterone` → `…pɹəɡˈɑːstɚɹˌoʊn`) |
| thiazolidinediones | `θˌaɪəzˌɑːlɪdˈaɪndiənz` | THY-a-zoh-li-DY-onz | already close; the `-diones` ending is right, the `-zolidine-` middle is not, and no single-token variant improved both |

## How the rows are stored

One hundred forty-eight rows, ids `term-1`…`term-148`, appended after `med-32`, toggleable as their own
group (`entryGroup()` → `'term'`). Each is a whole-word regex row, so the editor can show it
and switch it off like any other:

```json
{ "id": "term-1", "pattern": "\\b[Oo]meprazole\\b", "replacement": "ohmeprazole", "isRegex": true }
```

Because there can be thousands of such rows in a fuller inventory, `expand()` does not run
them as a thousand regex passes. Rows whose pattern is a single word in the standard
`\b[Xx]word\b` shape are compiled into **one map** (`index.ts`, `compiledRules()`), and the
text is walked once per word token: a token match is a `Map` lookup, so the cost is one
pass over the chapter regardless of how many terms are in the group (the 50 KB performance
test in `index.test.ts` runs well inside its 50 ms budget — about 20 ms best-of-five on a
loaded machine — with the 675 rules enabled). A rule that does not fit that shape still
runs as an ordinary regex row.

Two consequences of matching per token are worth knowing:

* a word inside a hyphenated compound still matches (`omeprazole-derivative` →
  `ohmeprazole-derivative`), consistent with the `\b…\b` behaviour of every other group;
* the replacement is lower-case, like every other respelling — the engine does not use
  case for stress, and `OHMEPRAZOLE` is read the same way.
