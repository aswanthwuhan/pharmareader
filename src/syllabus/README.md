# Syllabus defaults

`nmc-md-pharm.json` is the **editable default** topic tree for MD Pharmacology
(India), built from the syllabus and competency sections of the National Medical
Commission's *Guidelines for Competency Based Postgraduate Training Programme for
MD in Pharmacology* (revised), document no. `D 11011/1/22/AC/Guidelines/PG`,
dated 01-08-2022.

- Source: <https://www.nmc.org.in/storage/new/MD-in-Pharmacology-(revised).pdf>
  (linked from the NMC "Information Desk for Colleges — PG Curriculum" page).
  Downloaded and read on **2026-11-09**; the broad topics (syllabus points on
  pages 10–13) were used as the coverage checklist.
- Verified against that official PDF: domains and sub-topic **titles** were
  checked one by one against the document's syllabus headings and listed
  competencies. No paragraph, definition or competency number is copied — the
  tree carries titles only.
- It is still **not an official NMC publication**: wording is shortened for a
  sidebar, grouping follows the app's 26-domain shape rather than the document's
  numbering, and the level (basic/intermediate/advanced) is our own editorial
  grading, not an NMC classification. Treat it as a starting point users can
  rename, re-level, extend or reset.

## Shape

- 26 domains, 3–15 sub-topics each (237 topics in total).
- The 41 broad topics of the NMC syllabus are grouped into these 26 domains;
  where a broad topic is small it shares a domain (TDM, pharmacovigilance and
  drug utilisation sit under Clinical Pharmacology; heavy-metal poisoning and
  non-metallic toxicants under Toxicology; calcium homeostasis under Endocrine).
  Reproductive pharmacology keeps its own domain because the document treats it
  as a separate syllabus block.
- Topics carry **titles only**, never content.
- `id` is a stable slug. Renaming a topic in the app keeps its id, so book tags,
  highlights and cards stay attached; do not change an existing id by hand.
  Ids moved between domains are deliberately kept (`misc-vitamins`,
  `misc-chelators`, `misc-vaccines`, `misc-toxicology`, `misc-antidotes`,
  `misc-dermatological`, `misc-ocular`) so existing tags survive the move; new
  ids never reuse a retired one.
- `parentId` is `null` for a top-level domain, otherwise the parent's id.
- `level` is `basic`, `intermediate` or `advanced`; `order` sorts siblings.
- The app copies this file into IndexedDB on first run (`ensureSyllabusSeeded`).
  After that the database is the source of truth; "Reset to defaults" in the
  Syllabus page restores this tree while keeping topics the user created
  (`custom: true`).

## Coverage notes

Compared with the pre-review version, this tree adds the areas the old one
lacked: pharmacy practice (dispensing, hospital drug store, formulary, DTC, drug
information, medication safety, drug delivery systems), toxicology (including
pesticides/air pollutants and analytical toxicology), pharmacoepidemiology and
drug utilisation, national health programmes, dietary supplements and herbal
medicine, biochemical/analytical pharmacology, drug regulation (Drugs & Cosmetics
Act, schedules, GMP/GLP, EUA), DMARDs/gout, autoimmune disease and GVHD,
reproductive pharmacology, calcium and uterine drugs, synaptic/neuroeffector
drugs, drug counselling, screening methods, EC50/pD2/pA2, research protocols,
and the official teaching, curriculum, literature-search, pharmacometrics and
lab-animal sections.

## Editing

To edit the shipped tree, change the JSON and run `pnpm vitest run src/syllabus`:
`defaults.test.ts` checks unique ids, resolvable parents, valid levels, the
26-domain/3–15-sub-topic bounds and that the official syllabus areas are still
represented.
