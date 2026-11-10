# Drug-name respellings (`rx-*` entries)

The neural voice (Kokoro) falls back to espeak-ng for anything not in its
dictionary, and espeak-ng mangles a predictable set of generic names: it reads
a final **-ine** as /aɪn/ ("nife-di-PINE") where the standard pronunciation is
/iːn/ ("nife-di-peen"), it splits "-azepine" into an extra syllable, and it
turns "-xime" into /aɪm/. The entries below rewrite those words into a
phonetic spelling *before* the text reaches the phonemizer.

They are ordinary lexicon rules with ids `rx-<n>`, so they can be switched off
as a group (`entryGroup(id) === 'drug'`) without touching the clinical rules.
Each pattern is a whole-word match, first letter case-insensitive, so
"Nifedipine" at the start of a sentence matches but "hydroxychloroquine" does
not trigger the "chloroquine" rule.

Rule of thumb used when deciding whether to add one: only when espeak-ng was
*audibly* wrong (wrong final vowel, dropped syllable, letter-spelling), and
only when the respelling measurably improved the IPA. Where no candidate
improved it, the word was left alone (see the end of this file).

## Errors fixed

| Drug | Before (espeak-ng) | After (respell → IPA) |
| --- | --- | --- |
| nifedipine | nˈaɪfdɪpˌaɪn "nife-di-PINE" | nifedipeen → nˈaɪfdɪpˌiːn |
| amlodipine | ˈæmlədˌɪpaɪn | amlodipeen → ˈæmlədˌɪpiːn |
| olanzapine | ɑːlˈænzɐpˌaɪn | olanzapeen → ɑːlˈænzɐpˌiːn |
| clozapine | klˈɑːzɐpˌaɪn | clozapeen → klˈɑːzɐpˌiːn |
| carbamazepine | kˈɑːɹbɐmˌeɪzɪpˌaɪn "kar-ba-MAY-zi-pine" | carbamazapeen → kˈɑːɹbɐmˌeɪzɐpˌiːn |
| lamotrigine | lˈæmətɹˌɪdʒɪn "la-MO-tri-gin" | lamotrijeen → lˈæmətɹˌɪdʒiːn |
| amitriptyline | ˈæmɪtɹˌɪptɪlˌaɪn "…-ti-LINE" | amitriptileen → ˈæmɪtɹˌɪptɪlˌiːn |
| nortriptyline | nˈɔːɹtɹɪptˌɪlaɪn | nortriptileen → nˈɔːɹtɹɪptˌɪliːn |
| theophylline | θiːəfˈɪlaɪn "thee-OFF-i-line" | theofileen → θiːəfˈɪliːn |
| aminophylline | ɐmˈɪnəfˌɪlaɪn | aminofileen → ɐmˈɪnəfˌɪliːn |
| pyridoxine | pˈɪɹɪdˌɑːksaɪn | pyridoxeen → pˈɪɹɪdˌɑːksiːn |
| thiamine | θˈaɪəmˌaɪn "THYE-a-mine" | thiameen → θˈaɪəmˌiːn |
| levothyroxine | lˈɛvəθˌɪɹəksˌaɪn | levothyroxeen → lˈɛvəθˌɪɹəksˌiːn |
| chloroquine | klˌoːɹoʊkwˈaɪn | chlorokween → klˌoːɹoʊkwˈiːn |
| hydroxychloroquine | haɪdɹˈɑːksɪklˌoːɹoʊkwˌaɪn | hydroxychlorokween → haɪdɹˈɑːksɪklˌoːɹoʊkwˌiːn |
| primaquine | pɹˈaɪmɐkwˌaɪn | primakween → pɹˈaɪmɐkwˌiːn |
| mefloquine | mˈɛfləkwˌaɪn | meflokween → mˈɛfləkwˌiːn |
| atropine | ˈætɹəpˌaɪn "AT-ro-pine" | atropene → ˈætɹoʊpˌiːn |
| neostigmine | nˈiːoʊstˌɪɡmaɪn | neostigmeen → nˈiːoʊstˌɪɡmiːn |
| pyridostigmine | pˈɪɹɪdˌɑːstɪɡmˌaɪn | pyridostigmeen → pˈɪɹɪdˌɑːstɪɡmˌiːn |
| nevirapine | nˈɛvɚɹˌæpaɪn | nevirapeen → nˈɛvɚɹˌæpiːn |
| cefuroxime | sˈɛfjʊɹɹˌɑːksaɪm | cefuroxeem → sˌɛfjʊɹɹəksˈiːm |
| cefotaxime | sˈɛfətˌæksaɪm | cefotaxeem → sˌɛfəɾɐksˈiːm |
| cefixime | sˈɛfɪksˌaɪm | cefixeem → sˌɛfɪksˈiːm |
| cefepime | sˈɛfɪpˌaɪm | cefepeem → sˌɛfɪpˈiːm |
| terbutaline | tˈɜːbjuːɾəlˌaɪn | terbutaleen → tˈɜːbjuːtˌæliːn |
| phenytoin | fˈɛnɪtˌɔɪn "FEN-i-toyn" | fenitowin → fˈɛnɪtˌoʊɪn |
| indomethacin | ɪndˈoʊmθɐsˌɪn "in-DOM-tha-sin" | indoh methasin → ɪndˈoʊ mˈɛθɐsˌɪn |
| paracetamol | pˈæɹəsˌɛɾɐmˌɑːl "…-SE-ta-mal" | parasseetamol → pˈæɹəsˌiːɾɐmˌɑːl |
| diltiazem | dˈɪlʃɪˌeɪzəm "dil-SHE-ay-zem" | diltyazem → dˈɪltɪˌeɪzəm |

Two of these are deliberately multi-word ("indoh methasin"), because the
phonemizer drops the second syllable of "indomethacin" otherwise; the pace
between the two words is the same as a normal space.

## Checked and left alone

Already correct, so no rule was added: morphine, diazepam, lorazepam,
digoxin, amiodarone, clopidogrel, warfarin, heparin, enoxaparin, insulin,
metformin, glibenclamide, atorvastatin/rosuvastatin/simvastatin, all
`-gliptin`, `-gliflozin`, `-glitazone`, `-sartan`, `-pril`, `-olol`,
`-prazole`, `-azole`, `-mycin`, `-cillin`, `-oxacin`,
`-triptan`, `-lukast`, `-dronate`, `-tidine`, `-azepam`, `-azepine` in
"oxcarbazepine", `-mab`/`-nib`/`-zumab`/`-tinib` (infliximab, rituximab,
bevacizumab, imatinib, erlotinib), vincristine, vinblastine, cyclosporine,
azathioprine, mercaptopurine, and quinine itself (correctly /ˈkwaɪnaɪn/).

**Round 3 update:** the books screen re-checked the `-cycline` family and the
remaining `-ine` drug names. espeak reads their final vowel /aɪn/ ("nife-di-PINE")
where the standard is /iːn/ ("nife-di-peen"), so `doxycycline`, `tetracycline`,
`minocycline`, `tigecycline`, `demeclocycline`, `omadacycline`, `anthracycline`,
`codeine`, `quetiapine` and ~90 more now ship as `term-` rows — see
[term-respellings.md](term-respellings.md) § Round 3.

Considered but skipped:

- **ceftazidime** — best candidate "ceftazideem" gives "sef-TAY-zi-DEEM"
  with the stress in the wrong place, and splitting it ("ceftazid eem")
  introduces a pause. Left unchanged.
- **levetiracetam** — the sounds are all present, only the stress is early
  ("LEV-i-TER-a-setam"); respelling could not move it without other damage.
- **metoprolol, nebivolol, formoterol, doxazosin, linezolid, granisetron,
  isoniazid, pyrazinamide, carbamazepine's "MAY-za"** — stress or minor vowel
  differences only; still clearly intelligible, and a respelling risked
  breaking them.
- **colchicine, nimesulide, pentazocine, fentanyl** — one syllable or one vowel
  off; below the "audibly wrong" bar.

## Letter names in replacements (not a drug rule, but the same phonemizer quirk)

espeak-ng reads a bare capital `A` as the indefinite article — /ə/, "uh" — in
*every* context, including after a period. So a replacement that spells a
letter sequence with plain capitals says the wrong thing:

| Written in the replacement | espeak-ng | Want |
| --- | --- | --- |
| `A C E` | /ɐ sˈiː ˈiː/ "uh see-ee" | /ˌeɪsˌiːˈiː/ |
| `A N S` | /ɐ ˌɛn ˈɛs/ | /ˌeɪˌɛnˈɛs/ |
| `H L A B` | /eɪtʃ ɛl ɐ biː/ | /eɪtʃ ɛl eɪ biː/ |
| `p K A` | /piː keɪ ɐ/ | /piː keɪ eɪ/ |
| `A T Pase` | "ay-tee-pays" | "ay-tee-pee-ase" |

Two spellings fix it, and both are used in the JSON:

- **Dot the run**: `A.C.E`, `A.N.S`, `A.L.T`, `H.L.A.B`, `A.T one`, `A.U.C`.
  Only works when *every* letter is separated by a dot — `A.C.E.` (dot only at
  the end) is still read as the article, and `A.Ch.E` makes espeak say "dot".
- **Spell a lone A as `eigh`**: `p eigh two` → /piː eɪ tuː/, `Class one eigh`,
  `hemoglobin eigh one C`, `GABA eigh`. `eigh` is the only spelling that yields
  /eɪ/ on its own; `ay`/`ey` come out as /aɪ/ and a dotted `A.` is still
  swallowed.

Exception: ATPase is written `A.T.P-ace` — `A.T.Pase` merges into "PASE"
("ay-tee-pays").

