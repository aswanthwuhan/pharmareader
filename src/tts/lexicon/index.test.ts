import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../../core/db';
import {
  BUILTIN_LEXICON,
  applyEntry,
  deleteUserEntry,
  expand,
  invalidate,
  lexiconVersion,
  listLexiconEntries,
  saveUserEntry,
  seedLexicon,
  setEntryEnabled,
} from './index';

afterEach(async () => {
  await db.delete();
  await db.open();
  invalidate();
});

describe('seedLexicon', () => {
  it('writes every built-in entry once, with positional ids', async () => {
    await seedLexicon();
    await seedLexicon(); // second call must not duplicate

    const rows = await db.lexicon.where('source').equals('builtin').toArray();
    expect(rows).toHaveLength(BUILTIN_LEXICON.length);
    expect(rows.every((r) => /^b-\d+$/.test(r.id))).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(150);
  });

  it('re-seeds changed built-ins but keeps the user toggle and user rows', async () => {
    await seedLexicon();
    await setEntryEnabled('b-1', false);
    await saveUserEntry({ pattern: 'CYP', replacement: 'C Y P', isRegex: true });

    // Simulate a bundled lexicon update by corrupting one stored row.
    await db.lexicon.update('b-2', { pattern: 'stale-pattern' });
    invalidate();
    await seedLexicon();

    expect((await db.lexicon.get('b-1'))?.enabled).toBe(false);
    expect((await db.lexicon.get('b-2'))?.pattern).toBe(BUILTIN_LEXICON[1]?.pattern);
    expect((await db.lexicon.where('source').equals('user').count())).toBe(1);
  });
});

describe('expand', () => {
  const cases: [string, string][] = [
    ['t½ of digoxin is 36 h', 'half-life of digoxin is 36 hours'],
    ['CYP3A4 inhibitors', 'C Y P three A four inhibitors'],
    ['Ca²⁺', 'calcium ion'],
    ['5 mg/kg i.v.', '5 milligrams per kilogram intravenous'],
    ['EC₅₀', 'E C fifty'],
    ['β₂ agonist', 'beta two agonist'],
    ['Na⁺/K⁺-ATPase', 'sodium potassium A T Pase'],
    ['0.5 mg/kg/h', '0.5 milligrams per kilogram per hour'],
    ['10 mg/kg/day', '10 milligrams per kilogram per day'],
    ['50 µg/m²', '50 micrograms per square meter'],
    ['F = 80%', 'bioavailability equals 80 percent'],
    ['2 μg/mL', '2 micrograms per milliliter'],
    ['500 mL of saline', '500 milliliters of saline'],
    ['40 mmHg', '40 millimeters of mercury'],
    ['250 mg b.d.', '250 milligrams twice daily'],
    ['t.i.d. after meals', 'three times daily after meals'],
    ['q.d. at HS', 'once daily at bedtime'],
    ['h/hr', 'hours'],
    ['10 U insulin', '10 units insulin'],
    ['50% of patients', '50 percent of patients'],
    ['dose ≥ 5 mg', 'dose greater than or equal to 5 milligrams'],
    ['0.5–2 mg', '0.5 to 2 milligrams'],
    ['NSAIDs', 'N S A I D'],
    ['5-HT3 antagonist', 'five H T three antagonist'],
    ['α and β receptors', 'alpha and beta receptors'],
    ['CYP2D6 poor metaboliser', 'C Y P two D six poor metaboliser'],
    ['P-gp efflux', 'P glycoprotein efflux'],
    ['1.5 L', '1.5 liters'],
    ['pH 7.4', 'pH 7.4'],
    ['Give 5mg/kg IV.', 'Give 5 milligrams per kilogram intravenous.'],
    ['Start 10mg PO daily.', 'Start 10 milligrams by mouth daily.'],
    ['Start 0.5mg at night.', 'Start 0.5 milligrams at night.'],
    ['Glucose was 100mg/dL.', 'Glucose was 100 milligrams per deciliter.'],
    ['The half-life of CYP3A4 substrates rises with ketoconazole.', 'The half-life of C Y P three A four substrates rises with ketoconazole.'],
  ];

  for (const [input, want] of cases) {
    it(`expands ${JSON.stringify(input)}`, async () => {
      expect(await expand(input)).toBe(want);
    });
  }

  it('expands arrows and percent without leaving doubled spaces', async () => {
    expect(await expand('hypotension → syncope')).toBe('hypotension leads to syncope');
    expect(await expand('BP↑, HR↓')).toBe('BP increases, HR decreases');
  });
});

// Realistic textbook-style prose, written for this test: the kind of sentence a
// pharmacology resident will actually hear. Each row pins the exact spoken form.
describe('pharmacology sentences', () => {
  const sentences: [string, string][] = [
    ['Digoxin has a narrow therapeutic index.', 'Digoxin has a narrow therapeutic index.'],
    ['The bioavailability (F) of digoxin is 80%.', 'The bioavailability of digoxin is 80 percent.'],
    ['F = 0.8 means that 80% reaches the circulation.', 'bioavailability equals 0.8 means that 80 percent reaches the circulation.'],
    ['F of levodopa falls with a high-protein meal.', 'bioavailability of levodopa falls with a high-protein meal.'],
    ['Clearance (CL) is 120 mL/min.', 'Clearance (C L) is 120 milliliters per minute.'],
    ['Volume of distribution (Vd) is 5 L/kg.', 'Volume of distribution (V D) is 5 liters per kilogram.'],
    ['Digoxin t½ is 36 h.', 'Digoxin half-life is 36 hours.'],
    ['Elimination t1/2 was 12 h.', 'Elimination half-life was 12 hours.'],
    ['Cmax was 250 ng/mL and Tmax was 2 h.', 'C max was 250 nanograms per milliliter and T max was 2 hours.'],
    ['The AUC was 45 mg·h/L.', 'The A U C was 45 milligram hours per liter.'],
    ['Css is 10 mg/L.', 'C S S is 10 milligrams per liter.'],
    ['Ke is 0.1 per h.', 'K E is 0.1 per hour.'],
    ['ka is 1.5 per h.', 'K A is 1.5 per hour.'],
    ['The EC50 is 2 nM and Emax 90%.', 'The E C fifty is 2 nanomolar and E max 90 percent.'],
    ['The pKa of the drug is 7.4.', 'The p K A of the drug is 7.4.'],
    ['Body temperature was 101 °F.', 'Body temperature was 101 degrees Fahrenheit.'],
    ['The patient is 38.5 °C.', 'The patient is 38.5 degrees Celsius.'],
    ['Body surface area is 1.7 m².', 'Body surface area is 1.7 square meters.'],
    ['CYP3A4 and CYP2D6 metabolise the drug.', 'C Y P three A four and C Y P two D six metabolise the drug.'],
    ['CYP2C19 poor metabolisers need a lower dose.', 'C Y P two C nineteen poor metabolisers need a lower dose.'],
    ['P-gp limits absorption.', 'P glycoprotein limits absorption.'],
    ['GABA-A receptors mediate sedation.', 'GABA A receptors mediate sedation.'],
    ['GABA-B receptors are metabotropic.', 'GABA B receptors are metabotropic.'],
    ['NMDA and AMPA receptors are excitatory.', 'N M D A and A M P A receptors are excitatory.'],
    ['COX-2 inhibitors spare the stomach.', 'C O X two inhibitors spare the stomach.'],
    ['COX-1 inhibition causes bleeding.', 'C O X one inhibition causes bleeding.'],
    ['5-HT3 antagonists prevent vomiting.', 'five H T three antagonists prevent vomiting.'],
    ['5-HT2A antagonism causes sedation.', 'five H T two A antagonism causes sedation.'],
    ['β1 blockade slows the heart.', 'beta one blockade slows the heart.'],
    ['β2 agonists bronchodilate.', 'beta two agonists bronchodilate.'],
    ['α1 blockers cause hypotension.', 'alpha one blockers cause hypotension.'],
    ['α2 agonists reduce sympathetic outflow.', 'alpha two agonists reduce sympathetic outflow.'],
    ['M2 receptors slow the heart.', 'M two receptors slow the heart.'],
    ['D2 blockade causes hyperprolactinaemia.', 'D two blockade causes hyperprolactinaemia.'],
    ['H1 blockers cause sedation.', 'H one blockers cause sedation.'],
    ['H2 blockers reduce acid secretion.', 'H two blockers reduce acid secretion.'],
    ['AT1 blockers lower blood pressure.', 'A T one blockers lower blood pressure.'],
    ['ACE inhibitors cause cough.', 'A C E inhibitors cause cough.'],
    ['ACEi therapy is first line.', 'A C E inhibitor therapy is first line.'],
    ['ARBs are used when ACE inhibitors fail.', 'A R B are used when A C E inhibitors fail.'],
    ['PPIs are given before breakfast.', 'P P I are given before breakfast.'],
    ['NSAIDs and SSRIs increase bleeding risk.', 'N S A I D and S S R I increase bleeding risk.'],
    ['SNRIs and TCAs treat neuropathic pain.', 'S N R I and T C A treat neuropathic pain.'],
    ['MAOIs interact with tyramine.', 'M A O I interact with tyramine.'],
    ['DMARDs slow joint damage.', 'D M A R D slow joint damage.'],
    ['LMWH is used for prophylaxis.', 'L M W H is used for prophylaxis.'],
    ['The INR was 2.5 and the aPTT was raised.', 'The I N R was 2.5 and the A P T T was raised.'],
    ['The QTc interval is prolonged.', 'The Q T C interval is prolonged.'],
    ['Na+/K+-ATPase is inhibited by digoxin.', 'sodium potassium A T Pase is inhibited by digoxin.'],
    ['Intracellular Ca²⁺ rises.', 'Intracellular calcium ion rises.'],
    ['Na⁺ and Cl⁻ are reabsorbed.', 'sodium and chloride are reabsorbed.'],
    ['HCO₃⁻ is lost in diarrhoea.', 'bicarbonate is lost in diarrhoea.'],
    ['NaHCO3 corrects metabolic acidosis.', 'sodium bicarbonate corrects metabolic acidosis.'],
    ['H₂O and CO₂ are products.', 'water and carbon dioxide are products.'],
    ['Normal saline is 0.9% NaCl.', 'Normal saline is 0.9 percent sodium chloride.'],
    ['KCl is added to the infusion.', 'potassium chloride is added to the infusion.'],
    ['O₂ saturation is 94%.', 'oxygen saturation is 94 percent.'],
    ['HbA1c was 9.2%.', 'hemoglobin A one C was 9.2 percent.'],
    ['SpO2 was 94% and PaO2 60 mmHg.', 'S p O two was 94 percent and P a O two 60 millimeters of mercury.'],
    ['L-type calcium channels are blocked.', 'L type calcium channels are blocked.'],
    ['L-dopa is combined with carbidopa.', 'L dopa is combined with carbidopa.'],
    ['D-penicillamine chelates copper.', 'D penicillamine chelates copper.'],
    ['Give 5 mg IV twice daily.', 'Give 5 milligrams intravenous twice daily.'],
    ['Give 1 mg IV once daily.', 'Give 1 milligram intravenous once daily.'],
    ['The dose is 5 mg/kg/day.', 'The dose is 5 milligrams per kilogram per day.'],
    ['Start 0.5 mg/kg/h.', 'Start 0.5 milligrams per kilogram per hour.'],
    ['Dopamine 5 µg/kg/min is infused.', 'Dopamine 5 micrograms per kilogram per minute is infused.'],
    ['Insulin 0.1 U/kg/h is infused.', 'Insulin 0.1 units per kilogram per hour is infused.'],
    ['Give 5 U/kg of the antibody.', 'Give 5 units per kilogram of the antibody.'],
    ['The patient weighs 70 kg and needs 1 g.', 'The patient weighs 70 kilograms and needs 1 gram.'],
    ['Give 1 L of saline.', 'Give 1 liter of saline.'],
    ['Mix 500 mL with 10 mL.', 'Mix 500 milliliters with 10 milliliters.'],
    ['The level is 2 mmol/L.', 'The level is 2 millimoles per liter.'],
    ['Serum potassium is 4 mEq/L.', 'Serum potassium is 4 milliequivalents per liter.'],
    ['Give 1 IU of insulin.', 'Give 1 international unit of insulin.'],
    ['The infusion runs at 30 mL/h.', 'The infusion runs at 30 milliliters per hour.'],
    ['Clearance is 1.5 L/min.', 'Clearance is 1.5 liters per minute.'],
    ['Take 1 tablet OD.', 'Take 1 tablet once daily.'],
    ['Paracetamol 500 mg, OD.', 'Paracetamol 500 milligrams, once daily.'],
    ['An overdose (OD) is common.', 'An overdose (OD) is common.'],
    ['Give it at HS.', 'Give it at bedtime.'],
    ['Use PRN for pain.', 'Use as needed for pain.'],
    ['Give 500 mg IV q6h.', 'Give 500 milligrams intravenous every 6 hours.'],
    ['Give 250 mg PO q8h.', 'Give 250 milligrams by mouth every 8 hours.'],
    ['Table 2 lists five drugs; Phase II trials are pending.', 'Table 2 lists five drugs; Phase II trials are pending.'],
    ['Type 2 diabetes and Vitamin D deficiency are common.', 'Type 2 diabetes and Vitamin D deficiency are common.'],
    ['IgG antibodies appear after 2 weeks.', 'IgG antibodies appear after 2 weeks.'],
    ['The (a) and (d) options are wrong.', 'The (a) and (d) options are wrong.'],
    ['Vitamin D2 is not 5-FU.', 'Vitamin D two is not 5-FU.'],
    ['The 24 h urine output was low.', 'The 24 hours urine output was low.'],
    ['The minimum dose is 2 mg.', 'The minimum dose is 2 milligrams.'],
    ['A 30 min infusion was stopped.', 'A 30 minutes infusion was stopped.'],
    ['The infant weighs 3 kg and receives 1 mg.', 'The infant weighs 3 kilograms and receives 1 milligram.'],
    ['The ratio is 1:2.', 'The ratio is 1:2.'],
    ['The dose is 1.5 mg b.d. and 2 mg q.h.s.', 'The dose is 1.5 milligrams twice daily and 2 milligrams at bedtime'],
    ['Hypotension → syncope.', 'Hypotension leads to syncope.'],
    ['Dose ≥ 5 mg and ≤ 10 mg.', 'Dose greater than or equal to 5 milligrams and less than or equal to 10 milligrams.'],
    ['Take 0.5–1 mg daily.', 'Take 0.5 to 1 milligram daily.'],
    ['The rate is ~50 mg/day.', 'The rate is approximately 50 milligrams per day.'],
    ['Use 1½ tablets.', 'Use 1 and a half tablets.'],
    ['The tablet is ½ of a 10 mg dose.', 'The tablet is half of a 10 milligrams dose.'],
    ['Pulse 80/min.', 'Pulse 80 per minute.'],
    ['The rate is 100 ng/mL/h.', 'The rate is 100 nanograms per milliliter per hour.'],
    ['BP↑, HR↓', 'BP increases, HR decreases'],
  ];

  it('covers at least 60 distinct sentences', () => {
    expect(sentences.length).toBeGreaterThanOrEqual(60);
  });

  for (const [input, want] of sentences) {
    it(`speaks ${JSON.stringify(input)}`, async () => {
      expect(await expand(input)).toBe(want);
    });
  }
});

describe('user entries', () => {
  it('runs user rules before built-ins and can be deleted', async () => {
    await seedLexicon();
    const e = await saveUserEntry({ pattern: '\\bKD\\b', replacement: 'K D value', isRegex: true });

    expect(await expand('KD 0.5 nM')).toBe('K D value 0.5 nanomolar');

    await deleteUserEntry(e.id);
    // No built-in rule for the uppercase form, so it now passes through untouched.
    expect(await expand('KD')).toBe('KD');
  });

  it('supports plain-text entries with regex-special replacements', async () => {
    await seedLexicon();
    await saveUserEntry({ pattern: 'cost $5', replacement: '$5 only', isRegex: false });
    expect(await expand('cost $5 per pill')).toBe('$5 only per pill');
  });

  it('toggles a built-in off, which also changes the lexicon version', async () => {
    await seedLexicon();
    const before = await lexiconVersion();
    const halfLife = BUILTIN_LEXICON.findIndex((e) => e.pattern.includes('½'));
    await setEntryEnabled(`b-${halfLife + 1}`, false);
    const after = await lexiconVersion();
    expect(after).not.toBe(before);
    // The generic ½ → "half" rule still applies; only the half-life rule is off.
    expect(await expand('t½ of digoxin')).toBe('t half of digoxin');
  });

  it('ignores a broken regex instead of throwing', async () => {
    await seedLexicon();
    await saveUserEntry({ pattern: '([unclosed', replacement: 'x', isRegex: true });
    expect(await expand('safe text')).toBe('safe text');
  });

  it('lists user entries before built-ins', async () => {
    await seedLexicon();
    const e = await saveUserEntry({ pattern: 'zzz', replacement: 'Z', isRegex: false });
    const rows = await listLexiconEntries();
    expect(rows[0]?.id).toBe(e.id);
    expect(rows[1]?.id).toBe('b-1');
  });
});

describe('applyEntry', () => {
  it('replaces every occurrence, not just the first', () => {
    const entry = { id: 'x', pattern: 'mg', replacement: 'milligrams', isRegex: false, source: 'user' as const, enabled: true };
    expect(applyEntry('1 mg, 2 mg', entry)).toBe('1 milligrams, 2 milligrams');
  });
});
