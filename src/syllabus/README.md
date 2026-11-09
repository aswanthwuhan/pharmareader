# Syllabus defaults

`nmc-md-pharm.json` is the **editable default** topic tree for MD Pharmacology
(India). It is modelled on the shape of the NMC competency-based postgraduate
curriculum — domains with sub-topics graded basic → intermediate → advanced —
but it is **not an official copy** of any NMC document and makes no claim to
competency-number accuracy. Treat it as a starting point users can rename,
re-level, extend or reset.

- Topics carry **titles only**, never content.
- `id` is a stable slug. Renaming a topic in the app keeps its id, so book tags,
  highlights and cards stay attached; do not change an existing id by hand.
- `parentId` is `null` for a top-level domain, otherwise the parent's id.
- `level` is `basic`, `intermediate` or `advanced`; `order` sorts siblings.
- The app copies this file into IndexedDB on first run (`ensureSyllabusSeeded`).
  After that the database is the source of truth; "Reset to defaults" in the
  Syllabus page restores this tree while keeping topics the user created
  (`custom: true`).

To edit the shipped tree, change the JSON and run `pnpm vitest run src/syllabus`:
`defaults.test.ts` checks unique ids, resolvable parents, valid levels and that
every domain has 4–15 sub-topics.
