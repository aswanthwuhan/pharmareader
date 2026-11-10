import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../core/db';
import {
  BUILTIN_LEXICON,
  applyEntry,
  deleteUserEntry,
  entryGroup,
  expand,
  invalidate,
  lexiconVersion,
  listLexiconEntries,
  saveUserEntry,
  seedLexicon,
  setEntryEnabled,
} from './index';
import rawNativeKnown from './kokoro-native-known.json?raw';

// Android speaks through sherpa-onnx, which reads the model's own lexicon before
// falling back to eSpeak; `expand(text, 'kokoro')` must skip the rows that file
// already pronounces. The platform check is the only thing the tests fake.
const native = vi.hoisted(() => ({ value: false }));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => native.value },
}));

afterEach(async () => {
  native.value = false;
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
    expect(rows.every((r) => /^(b|rx|med|term)-\d+$/.test(r.id))).toBe(true);
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
    // b-2 keeps its id even though new rows were inserted around it.
    const b2 = BUILTIN_LEXICON.find((e) => e.id === 'b-2');
    expect((await db.lexicon.get('b-2'))?.pattern).toBe(b2?.pattern);
    expect((await db.lexicon.where('source').equals('user').count())).toBe(1);
  });
});

describe('expand', () => {
  const cases: [string, string][] = [
    ['t½ of digoxin is 36 h', 'half-life of digoxin is 36 hours'],
    ['CYP3A4 inhibitors', 'C Y P three eigh four inhibitors'],
    ['Ca²⁺', 'calcium ion'],
    ['5 mg/kg i.v.', '5 milligrams per kilogram intravenous'],
    ['EC₅₀', 'E C fifty'],
    ['β₂ agonist', 'beta two agonist'],
    ['Na⁺/K⁺-ATPase', 'sodium potassium A.T.P-ace'],
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
    ['NSAIDs', 'N.S.A.I.D'],
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
    ['The half-life of CYP3A4 substrates rises with ketoconazole.', 'The half-life of C Y P three eigh four substrates rises with ketoconazole.'],
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
    ['F of levodopa falls with a high-protein meal.', 'bioavailability of leevodopa falls with a high-protein meal.'],
    ['Clearance (CL) is 120 mL/min.', 'Clearance (C L) is 120 milliliters per minute.'],
    ['Volume of distribution (Vd) is 5 L/kg.', 'Volume of distribution (V D) is 5 liters per kilogram.'],
    ['Digoxin t½ is 36 h.', 'Digoxin half-life is 36 hours.'],
    ['Elimination t1/2 was 12 h.', 'Elimination half-life was 12 hours.'],
    ['Cmax was 250 ng/mL and Tmax was 2 h.', 'C max was 250 nanograms per milliliter and T max was 2 hours.'],
    ['The AUC was 45 mg·h/L.', 'The A.U.C was 45 milligram hours per liter.'],
    ['Css is 10 mg/L.', 'C S S is 10 milligrams per liter.'],
    ['Ke is 0.1 per h.', 'K E is 0.1 per hour.'],
    ['ka is 1.5 per h.', 'K.A is 1.5 per hour.'],
    ['The EC50 is 2 nM and Emax 90%.', 'The E C fifty is 2 nanomolar and E max 90 percent.'],
    ['The pKa of the drug is 7.4.', 'The p K.A of the drug is 7.4.'],
    ['Body temperature was 101 °F.', 'Body temperature was 101 degrees Fahrenheit.'],
    ['The patient is 38.5 °C.', 'The patient is 38.5 degrees Celsius.'],
    ['Body surface area is 1.7 m².', 'Body surface area is 1.7 square meters.'],
    ['CYP3A4 and CYP2D6 metabolise the drug.', 'C Y P three eigh four and C Y P two D six metabolise the drug.'],
    ['CYP2C19 poor metabolisers need a lower dose.', 'C Y P two C nineteen poor metabolisers need a lower dose.'],
    ['P-gp limits absorption.', 'P glycoprotein limits absorption.'],
    ['GABA-A receptors mediate sedation.', 'GABA eigh receptors mediate sedation.'],
    ['GABA-B receptors are metabotropic.', 'GABA B receptors are metabotropic.'],
    ['NMDA and AMPA receptors are excitatory.', 'N.M.D.A and A.M.P.A receptors are excitatory.'],
    ['COX-2 inhibitors spare the stomach.', 'C O X two inhibitors spare the stomach.'],
    ['COX-1 inhibition causes bleeding.', 'C O X one inhibition causes bleeding.'],
    ['5-HT3 antagonists prevent vomiting.', 'five H T three antagonists prevent vomiting.'],
    ['5-HT2A antagonism causes sedation.', 'five H T two eigh antagonism causes sedation.'],
    ['β1 blockade slows the heart.', 'beta one blockade slows the heart.'],
    ['β2 agonists bronchodilate.', 'beta two agonists bronchodilate.'],
    ['α1 blockers cause hypotension.', 'alpha one blockers cause hypotension.'],
    ['α2 agonists reduce sympathetic outflow.', 'alpha two agonists reduce sympathetic outflow.'],
    ['M2 receptors slow the heart.', 'M two receptors slow the heart.'],
    ['D2 blockade causes hyperprolactinaemia.', 'D two blockade causes hyperprolactineemia.'],
    ['H1 blockers cause sedation.', 'H one blockers cause sedation.'],
    ['H2 blockers reduce acid secretion.', 'H two blockers reduce acid secretion.'],
    ['AT1 blockers lower blood pressure.', 'A.T one blockers lower blood pressure.'],
    ['ACE inhibitors cause cough.', 'A.C.E inhibitors cause cough.'],
    ['ACEi therapy is first line.', 'A.C.E inhibitor therapy is first line.'],
    ['ARBs are used when ACE inhibitors fail.', 'A.R.B are used when A.C.E inhibitors fail.'],
    ['PPIs are given before breakfast.', 'P P I are given before breakfast.'],
    ['NSAIDs and SSRIs increase bleeding risk.', 'N.S.A.I.D and S S R I increase bleeding risk.'],
    ['SNRIs and TCAs treat neuropathic pain.', 'S N R I and T.C.A treat neuropathic pain.'],
    ['MAOIs interact with tyramine.', 'M.A.O.I interact with tyramine.'],
    ['DMARDs slow joint damage.', 'D.M.A.R.D slow joint damage.'],
    ['LMWH is used for prophylaxis.', 'L M W H is used for prophylaxis.'],
    ['The INR was 2.5 and the aPTT was raised.', 'The I N R was 2.5 and the A.P.T.T was raised.'],
    ['The QTc interval is prolonged.', 'The Q T C interval is prolonged.'],
    ['Na+/K+-ATPase is inhibited by digoxin.', 'sodium potassium A.T.P-ace is inhibited by digoxin.'],
    ['Intracellular Ca²⁺ rises.', 'Intracellular calcium ion rises.'],
    ['Na⁺ and Cl⁻ are reabsorbed.', 'sodium and chloride are reabsorbed.'],
    ['HCO₃⁻ is lost in diarrhoea.', 'bicarbonate is lost in diarrhoea.'],
    ['NaHCO3 corrects metabolic acidosis.', 'sodium bicarbonate corrects metabolic acidosis.'],
    ['H₂O and CO₂ are products.', 'water and carbon dioxide are products.'],
    ['Normal saline is 0.9% NaCl.', 'Normal saline is 0.9 percent sodium chloride.'],
    ['KCl is added to the infusion.', 'potassium chloride is added to the infusion.'],
    ['O₂ saturation is 94%.', 'oxygen saturation is 94 percent.'],
    ['HbA1c was 9.2%.', 'hemoglobin eigh one C was 9.2 percent.'],
    ['SpO2 was 94% and PaO2 60 mmHg.', 'S p O two was 94 percent and P a O two 60 millimeters of mercury.'],
    ['L-type calcium channels are blocked.', 'L type calcium channels are blocked.'],
    ['L-dopa is combined with carbidopa.', 'L dopa is combined with carbidopa.'],
    ['D-penicillamine chelates copper.', 'D penicillamine keelates copper.'],
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
    ['Paracetamol 500 mg, OD.', 'parasseetamol 500 milligrams, once daily.'],
    ['An overdose (OD) is common.', 'An overdose (OD) is common.'],
    ['Give it at HS.', 'Give it at bedtime.'],
    ['Use PRN for pain.', 'Use as needed for pain.'],
    ['Give 500 mg IV q6h.', 'Give 500 milligrams intravenous every 6 hours.'],
    ['Give 250 mg PO q8h.', 'Give 250 milligrams by mouth every 8 hours.'],
    ['Table 2 lists five drugs; Phase II trials are pending.', 'Table 2 lists five drugs; Phase two trials are pending.'],
    ['Type 2 diabetes and Vitamin D deficiency are common.', 'Type 2 diabetes and Vitamin D deficiency are common.'],
    ['IgG antibodies appear after 2 weeks.', 'I G G antibodies appear after 2 weeks.'],
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

// Extended corpus: every rule family added in the 2026 lexicon expansion
// (abbreviations, dosing, statistics, units, chemistry, pharmacogenomics,
// trial phases, drug respellings). Each row pins the exact spoken form.
describe('extended pharmacology corpus', () => {
  const spoken: [string, string][] = [
    ['The ANS is divided into sympathetic and parasympathetic divisions.', 'The A.N.S is divided into sympathetic and parasympathetic divisions.'],
    ['GIT absorption of iron needs an acidic medium.', 'G I tract absorption of iron needs an acidic medium.'],
    ['The RAAS regulates sodium balance.', 'The R.A.A.S regulates sodium balance.'],
    ['The AV node delays the impulse.', 'The A.V node delays the impulse.'],
    ['An ECG was recorded during the attack.', 'An E C G was recorded during the attack.'],
    ['The EEG showed diffuse slowing.', 'The E E G showed diffuse slowing.'],
    ['Serum CrCl was 42 mL/min.', 'Serum createneen clearance was 42 milliliters per minute.'],
    ['ALT and AST were three times the upper limit.', 'A.L.T and A.S.T were three times the upper limit.'],
    ['ALP was raised in the cholestatic picture.', 'A.L.P was raised in the cholestatic picture.'],
    ['Two ADRs were reported to the pharmacovigilance cell.', 'Two A.D.R were reported to the pharmacovigilance cell.'],
    ['An ICSR must be filed within 24 hours.', 'An I C S R must be filed within 24 hours.'],
    ['The BA/BE study was approved by the DCGI.', 'The B.A.B.E study was approved by the DCGI.'],
    ['ESBL-producing organisms need a carbapenem.', 'E S B L-producing organisms need a carbapenem.'],
    ['VRE was isolated from the wound.', 'V R E was isolated from the wound.'],
    ['The MIC of meropenem was 2 µg/mL.', 'The M I C of meropenem was 2 micrograms per milliliter.'],
    ['The IEC and IRB approved the protocol.', 'The I E C and I R B approved the protocol.'],
    ['The drug is on the EML and the NLEM.', 'The drug is on the E M L and the NLEM.'],
    ['PAE lasts up to 4 hours with gentamicin.', 'P.A.E lasts up to 4 hours with gentamicin.'],
    ['LC-MS/MS was used for the assay.', 'L C M S M S was used for the assay.'],
    ['The IL-6 level fell after tocilizumab.', 'The I L 6 level fell after tocilizumab.'],
    ['IgE antibodies mediate type I hypersensitivity.', 'I G E antibodies mediate type I hypersensitivity.'],
    ['MAO-A inhibitors treat atypical depression.', 'M.A.O.A inhibitors treat atypical depression.'],
    ['Selegiline is an MAO-B inhibitor.', 'Selegiline is an M.A.O.B inhibitor.'],
    ['AChE inhibitors are used in myasthenia gravis.', 'A.C.H.E inhibitors are used in myasthenia gravis.'],
    ['Donepezil is an AChEI.', 'dohneppezil is an A.C.H.E inhibitor.'],
    ['ROS accumulate during reperfusion.', 'R O S accumulate during reperfusion.'],
    ['eNOS and iNOS differ in their calcium requirement.', 'E N O S and I N O S differ in their calcium requirement.'],
    ['NO synthase produces nitric oxide.', 'nitric oxide synthase produces nitric oxide.'],
    ['PI3K signalling drives cell growth.', 'P I three K signalling drives cell growth.'],
    ['EGFR mutations predict response to gefitinib.', 'E G F R mutations predict response to gefitinib.'],
    ['VEGF and VEGFR2 mediate angiogenesis.', 'V E G F and V E G F receptor 2 mediate angiogenesis.'],
    ['NADPH oxidase generates superoxide.', 'N.A.D.P.H oxidase generates superoxide.'],
    ['DAG and IP3 are second messengers.', 'D.A.G and IP3 are second messengers.'],
    ['The nAChR is a ligand-gated channel.', 'The nicotinic asetilcholene receptor is a ligand-gated channel.'],
    ['mAChR blockade causes dry mouth.', 'muscarinic asetilcholene receptor blockade causes dry mouth.'],
    ['CCBs reduce peripheral resistance.', 'C C B reduce peripheral resistance.'],
    ['SGLT2 inhibitors protect the kidney.', 'S G L T two inhibitors protect the kidney.'],
    ['DPP-4 inhibitors are weight neutral.', 'D P P four inhibitors are weight neutral.'],
    ['GLP-1 receptor agonists reduce appetite.', 'G L P one receptor agonists reduce appetite.'],
    ['GLP-1RA therapy is given weekly.', 'G L P one receptor agonist therapy is given weekly.'],
    ['TZDs cause weight gain and oedema.', 'T Z D cause weight gain and oedeema.'],
    ['SUs increase insulin release.', 'sulfonylureas increase insulin release.'],
    ['DOACs are preferred over warfarin.', 'D.O.A.C are preferred over warfarin.'],
    ['INSTI-based regimens are first line.', 'I N S T I-based regimens are first line.'],
    ['HLA-B*5801 predicts allopurinol hypersensitivity.', 'H.L.A.B fifty-eight oh one predicts allopurinol hypersensitivity.'],
    ['HLA-B*1502 testing is done before carbamazepine.', 'H.L.A.B fifteen oh two testing is done before carbamazapeen.'],
    ['CYP2C19*2 carriers respond poorly to clopidogrel.', 'C Y P two C nineteen star two carriers respond poorly to clopidogrel.'],
    ['UGT1A1*28 increases irinotecan toxicity.', 'U G T one eigh one star twenty-eight increases irinotecan toxicity.'],
    ['VKORC1 variants affect the warfarin dose.', 'V K O R C one variants affect the warfarin dose.'],
    ['TPMT deficiency causes azathioprine toxicity.', 'T P M T deficiency causes azathioprine toxicity.'],
    ['SLCO1B1 variants raise simvastatin myopathy risk.', 'S L C O one B one variants raise simvastatin myopathy risk.'],
    ['Phase III trials are needed for approval.', 'Phase three trials are needed for approval.'],
    ['A phase II study enrolled 120 patients.', 'A phase two study enrolled 120 patients.'],
    ['Class Ia antiarrhythmics widen the QRS complex.', 'Class one eigh antiarrhythmics widen the QRS complex.'],
    ['Class IV agents are verapamil and diltiazem.', 'Class four agents are verapamil and diltyazem.'],
    ['Class III drugs prolong repolarisation.', 'Class three drugs prolong repolarisation.'],
    ['The result was significant at p < 0.05.', 'The result was significant at p less than 0.05.'],
    ['The hazard ratio was 0.72 (95% CI 0.55–0.94).', 'The hazard ratio was 0.72 (95 percent confidence interval 0.55 to 0.94).'],
    ['The OR = 2.1 for the high-risk group.', 'The odds ratio equals 2.1 for the high-risk group.'],
    ['RR = 1.8 in smokers.', 'relative risk equals 1.8 in smokers.'],
    ['The χ² test was used for the comparison.', 'The chi square test was used for the comparison.'],
    ['The SEM was small in this sample.', 'The S E M was small in this sample.'],
    ['The ARR was 3.5 percent.', 'The A.R.R was 3.5 percent.'],
    ['Values are given as mean ± SD.', 'Values are given as mean plus or minus SD.'],
    ['Give 100 mg/m² every 21 days.', 'Give 100 milligrams per square meter every 21 days.'],
    ['The dose is 15 µg/m²/day.', 'The dose is 15 micrograms per square meter per day.'],
    ['Creatinine clearance is 60 mL/min/1.73 m².', 'createneen clearance is 60 milliliters per minute per 1.73 square meters.'],
    ['The level was 45 µmol/L.', 'The level was 45 micromoles per liter.'],
    ['The infusion is 0.5 mg/h.', 'The infusion is 0.5 milligrams per hour.'],
    ['Platelets were 40 × 10⁹/L.', 'Platelets were 40 times ten to the nine per liter.'],
    ['The molecular weight is 42 kDa.', 'The molecular weight is 42 kilodaltons.'],
    ['The solution is 0.9% w/v.', 'The solution is 0.9 percent weight by volume.'],
    ['Osmolality was 290 mOsm/kg.', 'Osmolality was 290 milliosmoles per kilogram.'],
    ['The level is 2 ppm in the effluent.', 'The level is 2 parts per million in the effluent.'],
    ['The infusion was 30 µg/min.', 'The infusion was 30 micrograms per minute.'],
    ['Give 5-10 mg of the drug.', 'Give 5 to 10 milligrams of the drug.'],
    ['The concentration is 1:1000.', 'The concentration is one in one thousand.'],
    ['The rate is 3 L/h.', 'The rate is 3 liters per hour.'],
    ['The sample contained 20 pg/mL.', 'The sample contained 20 picograms per milliliter.'],
    ['The dose is 10 mg/kg/min.', 'The dose is 10 milligrams per kilogram per minute.'],
    ['H⁺/K⁺-ATPase is blocked by omeprazole.', 'hydrogen potassium A.T.P-ace is blocked by ohmeprazole.'],
    ['CaCl₂ was infused slowly.', 'calcium chloride was infused slowly.'],
    ['MgSO₄ is used for eclampsia.', 'magnesium sulfate is used for eclampsia.'],
    ['Fe²⁺ is absorbed in the duodenum.', 'ferrous ion is absorbed in the duodenum.'],
    ['Fe³⁺ is less soluble at alkaline pH.', 'ferric ion is less soluble at alkaline pH.'],
    ['Zn²⁺ is a cofactor for many enzymes.', 'zinc ion is a cofactor for many enzymes.'],
    ['Li⁺ has a narrow therapeutic index.', 'lithium ion has a narrow therapeutic index.'],
    ['NH₄⁺ excretion rises in acidosis.', 'ammonium excretion rises in acidosis.'],
    ['H₂O₂ decomposes to water and oxygen.', 'hydrogen peroxide decomposes to water and oxygen.'],
    ['Take 1 tablet q.h. while awake.', 'Take 1 tablet every hour while awake.'],
    ['Give paracetamol 500 mg q6h.', 'Give parasseetamol 500 milligrams every 6 hours.'],
    ['Give 250 mg q8h PRN.', 'Give 250 milligrams every 8 hours as needed.'],
    ['Give 5 mg ac.', 'Give 5 milligrams before meals.'],
    ['Give 10 mg pc.', 'Give 10 milligrams after meals.'],
    ['Give atropine 0.6 mg IV stat.', 'Give atropene 0.6 milligrams intravenous immediately.'],
    ['Give 1 ampoule IV stat.', 'Give 1 ampoule intravenous immediately.'],
    ['Diclofenac 50 mg (PR) was given.', 'Diclofenac 50 milligrams (per rectum) was given.'],
    ['The (IN) route is used for desmopressin.', 'The (intranasal) route is used for desmopressin.'],
    ['Methotrexate 12 mg (IT) was given.', 'Methotrexate 12 milligrams (intrathecal) was given.'],
    ['Add water q.s. to 100 mL.', 'Add water as much as needed to 100 milliliters.'],
    ['Sig. 1 tablet twice daily.', 'directions 1 tablet twice daily.'],
    ['Give 500 mg t.i.d. after meals.', 'Give 500 milligrams three times daily after meals.'],
    ['Give 500 mg q6-8h.', 'Give 500 milligrams every 6 to 8 hours.'],
    ['The dose is 2 mg/kg/day in two divided doses.', 'The dose is 2 milligrams per kilogram per day in two divided doses.'],
    ['Amiodarone 150 mg IV was given over 10 min.', 'Amiodarone 150 milligrams intravenous was given over 10 minutes.'],
    ['Digoxin 0.25 mg OD was started.', 'Digoxin 0.25 milligrams once daily was started.'],
    ['Phenytoin 15 mg/kg IV loading dose.', 'fenitowin 15 milligrams per kilogram intravenous loading dose.'],
    ['Give 20 mEq KCl in 500 mL.', 'Give 20 milliequivalents potassium chloride in 500 milliliters.'],
    ['The child weighs 12 kg and needs 15 mg/kg/day.', 'The child weighs 12 kilograms and needs 15 milligrams per kilogram per day.'],
    ['Infuse 5 µg/kg/min of dobutamine.', 'Infuse 5 micrograms per kilogram per minute of dobutamine.'],
    ['Serum creatinine is 1.8 mg/dL.', 'Serum createneen is 1.8 milligrams per deciliter.'],
    ['The Hb was 8.2 g/dL.', 'The Hb was 8.2 grams per deciliter.'],
    ['Total protein was 6.4 g/dL.', 'Total protein was 6.4 grams per deciliter.'],
    ['Blood glucose was 210 mg/dL.', 'Blood glucose was 210 milligrams per deciliter.'],
    ['The CSF protein was 90 mg/dL.', 'The CSF protein was 90 milligrams per deciliter.'],
    ['Give 2 L/min of oxygen.', 'Give 2 liters per minute of oxygen.'],
    ['The culture grew 10⁵ CFU/mL.', 'The culture grew ten to the five colony forming units per milliliter.'],
    ['The MIC was 0.5 µg/mL for both strains.', 'The M I C was 0.5 micrograms per milliliter for both strains.'],
    ['Give insulin 0.1 U/kg/h.', 'Give insulin 0.1 units per kilogram per hour.'],
    ['The patient received 2 IU/kg of antivenom.', 'The patient received 2 international units per kilogram of antivenom.'],
    ['The halflife was 6 h in renal failure.', 'The halflife was 6 hours in renal failure.'],
    ['Give 1 g IV q12h.', 'Give 1 gram intravenous every 12 hours.'],
    ['Give 500 mg PO BD.', 'Give 500 milligrams by mouth twice daily.'],
    ['Give 250 mg SOS for pain.', 'Give 250 milligrams if needed for pain.'],
    ['Give 10 mg HS.', 'Give 10 milligrams at bedtime.'],
    ['The QT interval was 480 ms.', 'The Q T interval was 480 milliseconds.'],
    ['A prolonged QTc predicts torsades.', 'A prolonged Q T C predicts torsades.'],
    ['The drug has a narrow TI.', 'The drug has a narrow therapeutic index.'],
    ['GABA-A receptors are chloride channels.', 'GABA eigh receptors are chloride channels.'],
    ['β1 and β2 receptors differ in G protein coupling.', 'beta one and beta two receptors differ in G protein coupling.'],
    ['α1 blockade causes postural hypotension.', 'alpha one blockade causes postural hypotension.'],
    ['M2 and M3 receptors mediate bradycardia.', 'M two and M three receptors mediate bradycardia.'],
    ['D2 blockade raises prolactin.', 'D two blockade raises prolactin.'],
    ['H1 blockade causes sedation.', 'H one blockade causes sedation.'],
    ['AT1 blockade lowers aldosterone.', 'A.T one blockade lowers aldosterone.'],
    ['5-HT3 antagonists prevent emesis.', 'five H T three antagonists prevent emesis.'],
    ['COX-2 selective agents spare platelets.', 'C O X two selective agents spare platelets.'],
    ['Na⁺ and K⁺ gradients drive the potential.', 'sodium and potassium gradients drive the potential.'],
    ['Cl⁻ influx hyperpolarises the cell.', 'chloride influx hyperpolarises the cell.'],
    ['Ca²⁺ entry triggers contraction.', 'calcium ion entry triggers contraction.'],
    ['HCO₃⁻ and H⁺ buffer the plasma.', 'bicarbonate and hydrogen ion buffer the plasma.'],
    ['The 24–48 h window matters.', 'The 24 to 48 hours window matters.'],
    ['Give 0.5–1 mg at night.', 'Give 0.5 to 1 milligram at night.'],
    ['A 30–60 min infusion is enough.', 'A 30 to 60 minutes infusion is enough.'],
    ['The dose is 1-2 tablets.', 'The dose is 1 to 2 tablets.'],
    ['The rate is 60-100 beats/min.', 'The rate is 60 to 100 beats per minute.'],
    ['Body temperature was 39.2 °C.', 'Body temperature was 39.2 degrees Celsius.'],
    ['The child weighed 3.4 kg.', 'The child weighed 3.4 kilograms.'],
    ['BP was 90/60 mmHg.', 'BP was 90 over 60 millimeters of mercury.'],
    ['Pulse was 110/min.', 'Pulse was 110 per minute.'],
    ['Class of the drug is an NSAID.', 'Class of the drug is an N.S.A.I.D.'],
    ['The patient\'s weight is 60 kg.', 'The patient\'s weight is 60 kilograms.'],
    ['The ECG machine was calibrated.', 'The E C G machine was calibrated.'],
    ['Nifedipine 10 mg was started for hypertension.', 'nifedipeen 10 milligrams was started for hypertension.'],
    ['Paracetamol is the first-line antipyretic.', 'parasseetamol is the first-line antipyretic.'],
    ['The patient received hydroxychloroquine for lupus.', 'The patient received hydroxychlorokween for lupus.'],
    ['Chloroquine and primaquine were given together.', 'chlorokween and primakween were given together.'],
    ['Phenytoin 100 mg at night prevented seizures.', 'fenitowin 100 milligrams at night prevented seizures.'],
    ['Indomethacin suppositories were used for gout.', 'indoh methasin suppositories were used for gout.'],
    ['Cefuroxime 1.5 g IV was given preoperatively.', 'cefuroxeem 1.5 grams intravenous was given preoperatively.'],
    ['Amoxicillin and atropine were used together.', 'Amoxicillin and atropene were used together.'],
    ['Theophylline levels were monitored.', 'theofileen levels were monitored.'],
    ['Give 40 µg/kg/min of the drug.', 'Give 40 micrograms per kilogram per minute of the drug.'],
    ['The dose is 500 mg/m²/day.', 'The dose is 500 milligrams per square meter per day.'],
    ['Haemoglobin fell to 7.8 g/dL.', 'Haemoglobin fell to 7.8 grams per deciliter.'],
    ['The creatinine was 2.4 mg/dL.', 'The createneen was 2.4 milligrams per deciliter.'],
    ['The rate was 4 L/min by mask.', 'The rate was 4 liters per minute by mask.'],
    ['Serum sodium was 128 mmol/L.', 'Serum sodium was 128 millimoles per liter.'],
    ['The level was 18 nmol/L.', 'The level was 18 nanomoles per liter.'],
    ['The concentration was 250 ng/mL.', 'The concentration was 250 nanograms per milliliter.'],
    ['Give 1 g IV q8h.', 'Give 1 gram intravenous every 8 hours.'],
    ['Give 2 mg SC daily.', 'Give 2 milligrams subcutaneous daily.'],
    ['The audit was approved by the IEC.', 'The audit was approved by the I E C.'],
    ['The ICSR was submitted to CDSCO.', 'The I C S R was submitted to CDSCO.'],
    ['Serum ALT was 120 U/L.', 'Serum A.L.T was 120 units per liter.'],
    ['The INR was 3.2 on warfarin.', 'The I N R was 3.2 on warfarin.'],
    ['eGFR fell to 28 mL/min/1.73 m².', 'eGFR fell to 28 milliliters per minute per 1.73 square meters.'],
    ['The 5-HT3 antagonist was given IV.', 'The five H T three antagonist was given intravenous.'],
    ['The infusion ran at 100 mL/h.', 'The infusion ran at 100 milliliters per hour.'],
    ['The 95% CI excluded one.', 'The 95 percent confidence interval excluded one.'],
    ['The RR = 0.6 for the vaccinated group.', 'The relative risk equals 0.6 for the vaccinated group.'],
    ['The dose was 0.5 mg/kg q6h PRN.', 'The dose was 0.5 milligrams per kilogram every 6 hours as needed.'],
    ['The child was given 250 mg qid.', 'The child was given 250 milligrams four times daily.'],
    ['The ointment was applied 0.5% w/w.', 'The ointment was applied 0.5 percent weight by weight.'],
    ['The drug was given (IT) for leukaemia.', 'The drug was given (intrathecal) for leukaemia.'],
    ['No change was seen in the ECG.', 'No change was seen in the E C G.'],
    ['Class of the drug is an NSAID.', 'Class of the drug is an N.S.A.I.D.'],
    ['Vitamin A deficiency causes night blindness.', 'Vitamin eigh deficiency causes night blindness.'],
    ['Hepatitis A spreads by the faecal-oral route.', 'Hepatitis eigh spreads by the faecal-oral route.'],
    ['Influenza A causes seasonal epidemics.', 'Influenza eigh causes seasonal epidemics.'],
  ];

  // Ordinary text that the new rules must never touch: the words that look
  // like an abbreviation or a dose but are not.
  const untouched: string[] = [
    'The NNT was 12 and the NNH 40.',
    'Adrenaline 1 in 10,000 was given.',
    'The pH of the solution is 7.4.',
    'The patient improved after 3 days.',
    'no change was seen.',
    'There is no evidence of harm.',
    'Either A or B may be used.',
    'The drug is given in the morning.',
    'It is safe in pregnancy.',
    'The statistics were unremarkable.',
    'The status of the patient improved.',
    'The acid secretion fell.',
    'The phase of the trial was unknown.',
    'Vitamin D deficiency is common.',
    'Type 2 diabetes needs metformin.',
    '5-FU is a pyrimidine analogue.',
    'Carbon monoxide (CO) poisoning is common.',
    'Cardiac output (CO) fell in shock.',
    'The in vitro study was negative.',
    'A single dose was given.',
    'The PR interval was prolonged.',
    'He has a history of asthma.',
    'The pill is small.',
    'Aspirin is a weak acid.',
    'The ward was quiet.',
    'Nursing staff were trained.',
    'The trial was stopped early.',
    'Both arms received the drug.',
    'The patient refused consent.',
    'Randomisation was central.',
    'The bottle was labelled.',
    'No adverse event occurred.',
    'The diet was normal.',
    'The infant fed well.',
    'The mother was counselled.',
    'The drug acts on the heart.',
    'Blood was drawn at 8 am.',
    'The report is pending.',
    'The sample was haemolysed.',
    'The investigator signed the form.',
    'The tablet was crushed.',
    'The infusion site was clean.',
    'A placebo was used.',
    'Follow up after two weeks.',
    'Quinine was avoided in this patient.',
    'Blood gas showed a pH of 7.28.',
    'The NLEM lists essential medicines only.',
    'The ELISA was positive for dengue.',
    'PCR confirmed the diagnosis.',
    'The p value was 0.03.',
    'Vitamin D was supplemented.',
    'Type 2 diabetes needs metformin.',
    '5-FU is a pyrimidine analogue.',
    'The PI was low in this sample.',
    'The PR interval was prolonged.',
    'The patient is in the intensive care unit.',
    'It is safe to stop the drug.',
    'Either A or B may be used.',
    'The statistics were unremarkable.',
    'The status of the patient improved.',
    'The acid secretion fell.',
    'The phase of the trial was unknown.',
    'The in vitro study was negative.',
    'A single dose was given.',
    'The tablet was crushed and given.',
    'The mother was counselled about the drug.',
    'A placebo was used in both arms.',
    'The report is pending.',
  ];

  it('has at least 120 positive cases', () => {
    expect(spoken.length).toBeGreaterThanOrEqual(120);
  });

  it('has at least 40 negative cases', () => {
    expect(untouched.length).toBeGreaterThanOrEqual(40);
  });

  for (const [input, want] of spoken) {
    it(`speaks ${JSON.stringify(input)}`, async () => {
      expect(await expand(input)).toBe(want);
    });
  }

  for (const input of untouched) {
    it(`leaves ${JSON.stringify(input)} alone`, async () => {
      expect(await expand(input)).toBe(input);
    });
  }

  describe('performance', () => {
    it('expands a 50 KB chapter in under 50 ms', async () => {
      // A realistic chapter: the rows above, repeated to 50 KB.
      const source = spoken.map(([input]) => input).join(' ');
      let chapter = '';
      while (chapter.length < 50_000) chapter += source + ' ';
      chapter = chapter.slice(0, 50_000);

      await expand('warm up the regex cache'); // compile every pattern once

      // Best of five: the suite runs in parallel with the rest of the project,
      // and a single contended run is not evidence that the code got slower.
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 5; i++) {
        const started = performance.now();
        const out = await expand(chapter);
        best = Math.min(best, performance.now() - started);
        expect(out.length).toBeGreaterThan(40_000);
      }
      expect(best).toBeLessThan(50);
    });
  });
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
    await setEntryEnabled(BUILTIN_LEXICON[halfLife]!.id, false);
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

describe('drug respelling group', () => {
  it('marks every respelling as a drug entry', () => {
    expect(entryGroup('b-1')).toBe('core');
    expect(entryGroup('rx-1')).toBe('drug');
    expect(entryGroup('med-1')).toBe('medical');
    expect(entryGroup('term-1')).toBe('term');
    expect(
      BUILTIN_LEXICON.every(
        (e) =>
          entryGroup(e.id) ===
          (e.id.startsWith('rx-')
            ? 'drug'
            : e.id.startsWith('med-')
              ? 'medical'
              : e.id.startsWith('term-')
                ? 'term'
                : 'core'),
      ),
    ).toBe(true);
  });

  it('can be switched off as a group, leaving the drug names untouched', async () => {
    await seedLexicon();
    expect(await expand('Nifedipine 10 mg was started.')).toBe('nifedipeen 10 milligrams was started.');

    const rx = BUILTIN_LEXICON.filter((e) => entryGroup(e.id) === 'drug');
    expect(rx.length).toBeGreaterThanOrEqual(20);
    for (const e of rx) await setEntryEnabled(e.id, false);

    expect(await expand('Nifedipine 10 mg was started.')).toBe('Nifedipine 10 milligrams was started.');
    // A respelling never fires inside a longer word.
    expect(await expand('Quinine was avoided.')).toBe('Quinine was avoided.');
  });
});

describe('medical respelling group (hypo-/hyper- + -emia)', () => {
  // The hypo-/hyper- families are one morphology rule, not a word list: the
  // stem keeps its own spelling and gains the "ee" that every engine needs.
  const medical: Array<[string, string]> = [
    ['Hypoglycemia is common.', 'Hypoglyceemia is common.'],
    ['hyperglycemia', 'hyperglyceemia'],
    ['hypoglycaemia', 'hypoglyceemia'],
    ['Severe hypokalaemia was corrected.', 'Severe hypokaleemia was corrected.'],
    ['Hyperkalemia', 'Hyperkaleemia'],
    ['hyponatraemia', 'hyponatreemia'],
    ['Hypernatremia', 'Hypernatreemia'],
    ['hypocalcemia', 'hypocalceemia'],
    ['Hypocalcaemia', 'Hypocalceemia'],
    ['hypomagnesemia', 'hypomagneseemia'],
    ['hypophosphatemia', 'hypophosphateemia'],
    ['hypochloremia', 'hypochloreemia'],
    ['hypovolemia', 'hypovoleemia'],
    ['hyperlipidemia', 'hyperlipideemia'],
    ['hyperuricemia', 'hyperuriceemia'],
    ['hypertriglyceridemia', 'hypertriglycerideemia'],
    ['hypocholesterolemia', 'hypocholesteroleemia'],
    ['hyperbilirubinemia', 'hyperbilirubineemia'],
    ['hyperinsulinemia', 'hyperinsulineemia'],
    ['hypoalbuminemia', 'hypoalbumineemia'],
    ['hypoproteinemia', 'hypoproteineemia'],
    ['hypoxemia', 'hypoxeemia'],
    ['Hyperoxemia', 'Hyperoxeemia'],
    ['hyperprolactinaemia', 'hyperprolactineemia'],
    // -emic adjectives: only the stems whose vowel espeak-ng gets wrong.
    ['hypokalemic', 'hypokaleemic'],
    ['Hyperkalemic', 'Hyperkaleemic'],
    ['hypocalcemic', 'hypocalceemic'],
    ['hypocalcaemic', 'hypocalceemic'],
    // Never fires twice on its own output.
    ['Hypoglyceemia is fixed.', 'Hypoglyceemia is fixed.'],
  ];
  for (const [input, want] of medical) {
    it(`speaks ${JSON.stringify(input)}`, async () => {
      await seedLexicon();
      expect(await expand(input)).toBe(want);
    });
  }

  const untouched: string[] = [
    // Plain English that merely starts with the same letters.
    'hype',
    'Hyper',
    'hyperlink',
    'hyperlinks',
    'hypertext',
    'hyperactive',
    'hyperactivity',
    'hyperbole',
    'hyperbolic',
    'hypotenuse',
    'hypothesis',
    'hypotheses',
    'hypothetical',
    'hypocrite',
    'hypocrisy',
    'hypochondria',
    'hypochondriac',
    'hypodermic',
    'hypoallergenic',
    'hypothermia',
    'hypothyroidism',
    'hyperthyroidism',
    'hypertension',
    'hypotension',
    'hyperventilation',
    'hypoventilation',
    'hyperemesis',
    'hypopnea',
    'hyperpnea',
    'tachycardia',
    'bradycardia',
    // -emia words with another prefix, or with no prefix at all.
    'glycemia',
    'glycaemia',
    'euglycemia',
    'normoglycemia',
    'anemia',
    'anaemia',
    'septicemia',
    'bacteremia',
    'uremia',
    'leukemia',
    'hyperaemia',
    // Hyphens and casing that the rule deliberately leaves alone.
    'nonhypoglycemic',
    'hypoglycemias',
    'HYPOGLYCEMIA',
    'hypoglyc',
  ];
  for (const input of untouched) {
    it(`leaves ${JSON.stringify(input)} alone`, async () => {
      await seedLexicon();
      expect(await expand(input)).toBe(input);
    });
  }
});



describe('medical respelling group (-toxicity, -rrhea, -megaly, single words)', () => {
  // Every rule below was chosen by measurement: it had to move espeak-ng's IPA
  // (the phonemizer Kokoro uses) towards the intended reading, and it had to
  // survive Whisper recognition on the three engines in the check harness.
  // See src/tts/lexicon/medical-respellings.md for the before/after evidence.
  const words: Array<[string, string]> = [
    // -toxicity: the bare "o" prefix is a schwa in espeak-ng.
    ['Ototoxicity is dose related.', 'Ohtohtoxicity is dose related.'],
    ['hepatotoxicity', 'hepatohtoxicity'],
    ['Nephrotoxicity', 'Nephrohtoxicity'],
    ['cardiotoxicity', 'cardiohtoxicity'],
    // -rrhea: the British rrhoea spelling carries the stress.
    ['amenorrhea', 'amenorrhoea'],
    ['Steatorrhea', 'Steatorrhoea'],
    ['galactorrhea', 'galactorrhoea'],
    // kaliemia has no hypo-/hyper- prefix, so the -emia rule misses it.
    ['kaliemia was noted.', 'kaleemia was noted.'],
    // -megaly: espeak-ng swallows the vowel before the g.
    ['Hepatomegaly was present.', 'Hepatohmegalee was present.'],
    ['splenomegaly', 'spleenohmegalee'],
    ['nephromegaly', 'nefrohmegalee'],
    ['hepatosplenomegaly', 'hepatoospleenohmegalee'],
    // Single words, each with a measured defect in the plain reading.
    ['empyema', 'empyeema'],
    ['atelectasis', 'attelektasis'],
    ['hepatocyte', 'hepatohsite'],
    ['cholecystitis', 'coleesistitis'],
    ['pruritus', 'proorightus'],
    ['oophorectomy', 'oophoorectomee'],
    ['hemiparesis', 'hemiparresis'],
    ['hemiplegia', 'hemipleejia'],
    ['tracheitis', 'trakeeitis'],
    ['epididymitis', 'epididimitis'],
    ['pyelonephritis', 'pylonefritis'],
    ['ketoacidosis', 'ketoasidosis'],
    ['cecum', 'ceekum'],
    ['enalapril', 'enalapryl'],
    ['glycosuria', 'glykohsyooria'],
    ['dysuria', 'disyooria'],
    ['nocturia', 'nocktyooria'],
    ['hematochezia', 'hematokeesia'],
    ['Haematochezia', 'Haematokeesia'],
    ['gynaecomastia', 'gynaecomasteea'],
    ['gynecomastia', 'gynecomasteea'],
    ['erythema', 'erytheema'],
    // Already respelled: the rules must not fire twice.
    ['empyeema', 'empyeema'],
    ['ohtohtoxicity', 'ohtohtoxicity'],
    ['ceekum', 'ceekum'],
    ['amenorrhoea', 'amenorrhoea'],
  ];
  for (const [input, want] of words) {
    it(`speaks ${JSON.stringify(input)}`, async () => {
      await seedLexicon();
      expect(await expand(input)).toBe(want);
    });
  }

  const untouched: string[] = [
    // Same opening letters, different word.
    'ototoxic',
    'ototoxicty',
    'hepatotoxic',
    'neuralgic',
    'neuralgias',
    'hemiplegic',
    'cholecystectomy',
    'petechial',
    'erythematous',
    'tubulin',
    'tubules',
    'cecumx',
    'enalaprilat',
    'normokaliemia',
    'hepatocytes',
    'megakaryocytes',
    'diarrhoea',
    // Other -emias and -urias are read correctly already.
    'uremia',
    'pyuria',
    'polyuria',
    'anuria',
    'oliguria',
    'azotemia',
    'erythrocyte',
    'megalomania',
    'cardiomegaly',
    // The hypo-/hyper- family keeps its own boundaries.
    'hype',
    'hyperlink',
    'hypothesis',
    'hypocrite',
    'hypothermia',
    'hypertension',
    'hyperemesis',
    'anemia',
    'leukemia',
    'septicemia',
    // Respellings that were tried and reverted: the recognition round got worse
    // on at least two engines and no engine improved, so these stay as written.
    'digoxin',
    'tubule',
    'neuralgia',
    'bronchiectasis',
    'petechiae',
    'megakaryocyte',
  ];
  for (const input of untouched) {
    it(`leaves ${JSON.stringify(input)} alone`, async () => {
      await seedLexicon();
      expect(await expand(input)).toBe(input);
    });
  }
});
describe('chapter references (Ch 39 -> Chapter 39)', () => {
  const spoken: [string, string][] = [
    ['Ch 39', 'Chapter 39'],
    ['Ch. 39', 'Chapter 39'],
    ['ch 39', 'Chapter 39'],
    ['See Ch 12 for details.', 'See Chapter 12 for details.'],
    ['Ch 1', 'Chapter 1'],
    ['Ch 300', 'Chapter 300'],
    ['Chs 3-5', 'Chapters 3 to 5'],
    ['Chs 3–5', 'Chapters 3 to 5'],
    ['Chs. 3—5', 'Chapters 3 to 5'],
    ['Chs 3 to 5', 'Chapters 3 to 5'],
    ['Ch 39-41', 'Chapters 39 to 41'],
    ['Ch. 39–41', 'Chapters 39 to 41'],
    ['Ch 39 to 41', 'Chapters 39 to 41'],
    ['chs 10-12 were revised', 'Chapters 10 to 12 were revised'],
    ['Ch 39 and Ch 40', 'Chapter 39 and Chapter 40'],
  ];
  for (const [input, want] of spoken) {
    it(`speaks ${JSON.stringify(input)}`, async () => {
      expect(await expand(input)).toBe(want);
    });
  }

  const untouched = [
    'ChE inhibitors',
    'ACh release',
    'chloride channels',
    'Ch-',
    'Ch 301',
    'Ch 999',
    'CH 12', // Charrière gauge / heading initials, not a chapter
    'cholinergic crisis',
    'cholinesterase',
    'the chest wall',
    'Chs',
    'a chorea',
    'Ch 0',
    'Research Chapter 4 described it.',
  ];
  for (const input of untouched) {
    it(`leaves ${JSON.stringify(input)} alone`, async () => {
      expect(await expand(input)).toBe(input);
    });
  }

  it('never expands a bare Ch without a number', async () => {
    for (const s of ['Ch', 'ch', 'Ch.', 'ch.']) {
      expect(await expand(s)).toBe(s);
    }
  });

  it('leaves AChE to the letter-spelling rule, not to Ch', async () => {
    expect(await expand('AChE activity')).toBe('A.C.H.E activity');
  });

  it('is idempotent across both passes', async () => {
    const once = await expand('Ch 39 and Chs 3-5');
    expect(once).toBe('Chapter 39 and Chapters 3 to 5');
    expect(await expand(once)).toBe(once);
  });
});

describe('term respellings (screened against Kokoro + Whisper)', () => {
  const spoken: [string, string][] = [
    ['omeprazole', 'ohmeprazole'],
    ['Omeprazole 20 mg', 'ohmeprazole 20 milligrams'],
    ['esomeprazole was started', 'esohmeprazole was started'],
    ['pantoprazole infusion', 'pantohprazole infusion'],
    ['lansoprazole was added', 'lansohprazole was added'],
    ['acetylcholinesterase inhibitors', 'acetylcholinnesteraze inhibitors'],
    ['atorvastatin 40 mg', 'attorvastatin 40 milligrams'],
    ['palonosetron was given', 'palohnohsetrone was given'],
    ['granisetron is cheaper', 'granisitron is cheaper'],
    // The medical group still owns the -ine/-amine families; term- rows must
    // never shadow them (one rule per word).
    ['thiamine is a cofactor', 'thiameen is a cofactor'],
    ['pyridoxine deficiency', 'pyridoxeen deficiency'],
    // Round 2: the drug names the 900-clip baseline round trip failed on and a
    // hand-written single-token respelling measurably fixed.
    ['atenolol 50 mg', 'attennolol 50 milligrams'],
    ['donepezil at night', 'dohneppezil at night'],
    ['letrozole for breast cancer', 'letrohzole for breast cancer'],
    ['colestipol was stopped', 'kohlestipol was stopped'],
    ['droperidol is sedating', 'drohperidol is sedating'],
    ['topotecan weekly', 'tohpohteekan weekly'],
    ['probenecid blocks secretion', 'prohbenesid blocks secretion'],
    ['docetaxel infusion', 'dohsetaksel infusion'],
    ['risperidone was increased', 'risperridohn was increased'],
    ['mesoridazine is obsolete', 'mesohridazeen is obsolete'],
    ['emetics are listed', 'emmetiks are listed'],
    ['cholangiocarcinoma screening', 'kohlanjeeohkarsinoma screening'],
    ['levobupivacaine for the block', 'levohbuhpivakaine for the block'],
    ['pramipexole in restless legs', 'pramihpeksohl in restless legs'],
    ['tiletamine with zolazepam', 'tilletameen with zolazepam'],
    // Round 3: screened from the OCR'd pharmacology books (KD Tripathi 8e and the
    // exam banks) with the exact eSpeak NG front end. The -ine family dominates:
    // espeak reads the final vowel /aɪn/ ("nife-di-PINE") where the standard is
    // /iːn/ ("nife-di-peen").
    ['doxycycline 40 mg', 'doxycycleen 40 milligrams'],
    ['tetracycline was stopped', 'tetracycleen was stopped'],
    ['tyrosine is a precursor', 'tyroseene is a precursor'],
    ['adenosine was given', 'adenoseene was given'],
    ['lysine deficiency', 'lyseen deficiency'],
    ['capecitabine tablets', 'capecitabeen tablets'],
    ['quetiapine at night', 'quetiapeen at night'],
    ['oxcarbazepine was added', 'oxcarbazepeen was added'],
    ['cinchona bark', 'sinkona bark'],
    ['artemether was given', 'artemethir was given'],
    ['ascites was tapped', 'asytees was tapped'],
    ['nausea and vomiting', 'nauzia and vomiting'],
    ['cholangitis is painful', 'kolangitis is painful'],
    ['chitosan is used', 'kaitan is used'],
    ['subarachnoid bleed', 'subaraknoid bleed'],
    ['trichomonas infection', 'trikomonas infection'],
    ['onychomycosis of the nail', 'onikomycosis of the nail'],
    ['mesenchymal tumour', 'mesenkimal tumour'],
    ['chelators bind iron', 'keelators bind iron'],
    // Round 3b: two agent sweeps (top-frequency words and the medical-suffix
    // families) found these; each candidate was re-checked with the workbench.
    ['epinephrine was given', 'epinephrin was given'],
    ['antigen presentation', 'antegen presentation'],
    ['levodopa therapy', 'leevodopa therapy'],
    ['peripheral edema', 'peripheral ideema'],
    ['miosis is present', 'myosis is present'],
    ['hyperemia was noted', 'hypereemia was noted'],
    ['glioma of the brain', 'gleeoma of the brain'],
    ['hematuria was reported', 'heematuria was reported'],
    ['thrombocytopenia is common', 'thrombosyteopenia is common'],
    ['ketonuria in the morning', 'keetonuria in the morning'],
    ['acetylcholine receptors', 'asetilcholene receptors'],
    ['uveitis is painful', 'uveaitis is painful'],
    ['valproate was started', 'valproaate was started'],
    ['angioplasty was done', 'anjiohplasty was done'],
    ['pralidoxime was given', 'pralidokseme was given'],
    ['obidoxime is an oxime', 'obidokseme is an oxime'],
    ['bleomycin was infused', 'bleeohmycin was infused'],
    // Improvement 2: a plural or possessive the list has no row for reuses the
    // stem's respelling (see the dedicated `plurals and possessives` group).
    ['atorvastatins are used', 'attorvastatins are used'],
  ];
  for (const [input, want] of spoken) {
    it(`speaks ${JSON.stringify(input)}`, async () => {
      expect(await expand(input)).toBe(want);
    });
  }

  // Common English words must never be rewritten by the medical word map.
  const untouched = [
    'machine',
    'engine',
    'imagine',
    'routine',
    'examine',
    'determine',
    'famine',
    'genuine',
    'medicine',
    'decline',
    'combine',
    'discipline',
    'chlorine',
    'magazine',
    'tangerine',
    'maritime',
    'neoprene',
    'vaseline',
    'histamine',
    'dopamine',
    'serotonin',
    'caffeine',
    'nicotine',
    'cocaine',
    'morphine',
    'insulin',
    'penicillin',
    'aspirin',
    'heparin',
    'cyanocobalamin',
    'erythromycin',
    'vancomycin',
    'gentamicin',
    'metronidazole',
    'ketoconazole',
    'fluconazole',
    'rabeprazole', // screened, but the candidate regressed: kept as written
    'spironolactone', // screened, baseline already fine: kept as written
    'norepinephrine', // screened, no single-token fix found
    'furosemide', // screened, no single-token fix found
    'levetiracetam',
    'artesunate',
    'pyrazinamide',
    'oseltamivir',
    'linezolid',
    'celecoxib',
    'hydrochlorothiazide',
    'amoxicillin',
    'amoxicillin-clavulanate',
    'sotalol', // tried: the respelling phonemises identically, so it was dropped
    'ritanserin', // tried: the transcript did not change, so it was dropped
    'dutasteride', // tried: IPA improved but the round trip did not, so it was dropped
    'ionophores', // tried: the round trip regressed, so it was dropped
    'tinnitus', // screened, espeak is already right; the recogniser mishears it
    'taurine', // screened, already right
    'arsenates', // screened, already right
    'cholangiogram', // shares a prefix with a respelled term, not a term itself
    'emetic', // the rule covers the plural that the corpus uses, not this form
    'metoprolol', // -olol family that espeak already handles
    'bisoprolol',
    'ondansetron', // -setron family, but espeak already handles it
    'tropisetron',
  ];
  for (const input of untouched) {
    it(`leaves ${JSON.stringify(input)} alone`, async () => {
      expect(await expand(input)).toBe(input);
    });
  }

  it('leaves its own output alone', async () => {
    for (const [, want] of spoken) {
      expect(await expand(want)).toBe(want);
    }
  });

  it('is a switchable group', async () => {    await seedLexicon();
    expect(await expand('omeprazole')).toBe('ohmeprazole');
    const terms = BUILTIN_LEXICON.filter((e) => entryGroup(e.id) === 'term');
    expect(terms.length).toBeGreaterThanOrEqual(8);
    for (const e of terms) await setEntryEnabled(e.id, false);
    expect(await expand('omeprazole')).toBe('omeprazole');
  });

  it('keeps ids stable and every row a single whole-word rule', () => {
    const terms = BUILTIN_LEXICON.filter((e) => e.id.startsWith('term-'));
    // term-109, term-110, term-111 and term-147 were deleted (their plurals are
    // now handled by the stem rule); the gap is deliberate and the ids must
    // never be reused, so this list is exact rather than a range check.
    expect(terms.map((e) => e.id)).toEqual([
      'term-1',
      'term-2',
      'term-3',
      'term-4',
      'term-5',
      'term-6',
      'term-7',
      'term-8',
      'term-9',
      'term-10',
      'term-11',
      'term-12',
      'term-13',
      'term-14',
      'term-15',
      'term-16',
      'term-17',
      'term-18',
      'term-19',
      'term-20',
      'term-21',
      'term-22',
      'term-23',
      'term-24',
      'term-25',
      'term-26',
      'term-27',
      'term-28',
      'term-29',
      'term-30',
      'term-31',
      'term-32',
      'term-33',
      'term-34',
      'term-35',
      'term-36',
      'term-37',
      'term-38',
      'term-39',
      'term-40',
      'term-41',
      'term-42',
      'term-43',
      'term-44',
      'term-45',
      'term-46',
      'term-47',
      'term-48',
      'term-49',
      'term-50',
      'term-51',
      'term-52',
      'term-53',
      'term-54',
      'term-55',
      'term-56',
      'term-57',
      'term-58',
      'term-59',
      'term-60',
      'term-61',
      'term-62',
      'term-63',
      'term-64',
      'term-65',
      'term-66',
      'term-67',
      'term-68',
      'term-69',
      'term-70',
      'term-71',
      'term-72',
      'term-73',
      'term-74',
      'term-75',
      'term-76',
      'term-77',
      'term-78',
      'term-79',
      'term-80',
      'term-81',
      'term-82',
      'term-83',
      'term-84',
      'term-85',
      'term-86',
      'term-87',
      'term-88',
      'term-89',
      'term-90',
      'term-91',
      'term-92',
      'term-93',
      'term-94',
      'term-95',
      'term-96',
      'term-97',
      'term-98',
      'term-99',
      'term-100',
      'term-101',
      'term-102',
      'term-103',
      'term-104',
      'term-105',
      'term-106',
      'term-107',
      'term-108',
      'term-112',
      'term-113',
      'term-114',
      'term-115',
      'term-116',
      'term-117',
      'term-118',
      'term-119',
      'term-120',
      'term-121',
      'term-122',
      'term-123',
      'term-124',
      'term-125',
      'term-126',
      'term-127',
      'term-128',
      'term-129',
      'term-130',
      'term-131',
      'term-132',
      'term-133',
      'term-134',
      'term-135',
      'term-136',
      'term-137',
      'term-138',
      'term-139',
      'term-140',
      'term-141',
      'term-142',
      'term-143',
      'term-144',
      'term-145',
      'term-146',
      'term-148',
      'term-149',
      'term-150',
      'term-151',
      'term-152',
      'term-153',
      'term-154',
      'term-155',
      'term-156',
      'term-157',
      'term-158',
      'term-159',
      'term-160',
      'term-161',
      'term-162',
      'term-163',
      'term-164',
      'term-165',
      'term-166',
    ]);
    for (const e of terms) {
      expect(e.isRegex).toBe(true);
      expect(e.pattern).toMatch(/^\\b\[[A-Za-z][A-Za-z]\][A-Za-z]+\\b$/);
      // A respelling is one token: no spaces, no hyphens (see term-respellings.md).
      expect(e.replacement).toMatch(/^[a-z]+$/);
    }
  });

  it('runs the word map in one pass, matching whole tokens only', async () => {
    // The map is applied per word token, so a longer word never contains a hit.
    expect(await expand('omeprazolelike')).toBe('omeprazolelike');
    expect(await expand('OMEPRAZOLE')).toBe('ohmeprazole');
    expect(await expand('(omeprazole)')).toBe('(ohmeprazole)');
  });
});

describe('plurals and possessives (term word map)', () => {
  // These four used to be rows of their own; the stem rule now covers them.
  // Its output ends `-eens`, one letter shorter than the rows' `-eenes`;
  // eSpeak measures both /iːnz/ (identical IPA), so the speech is unchanged.
  const formerRows: [string, string][] = [
    ['benzodiazepines are sedating', 'benzodiazepeens are sedating'],
    ['tetracyclines were stopped', 'tetracycleens were stopped'],
    ['anthracyclines are cardiotoxic', 'anthracycleens are cardiotoxic'],
    ['chelates heavy metals', 'keelates heavy metals'],
  ];
  for (const [input, want] of formerRows) {
    it(`covers the deleted row for ${JSON.stringify(input)}`, async () => {
      expect(await expand(input)).toBe(want);
      expect(await expand(want)).toBe(want); // and its output is stable
    });
  }

  it('keeps the replacement and the possessive suffix', async () => {
    expect(await expand("the doxycycline's half-life")).toBe("the doxycycleen's half-life");
    expect(await expand('the doxycycline\u2019s half-life')).toBe('the doxycycleen\u2019s half-life');
    expect(await expand("tyrosine's role")).toBe("tyroseene's role");
  });

  it('lets an exact entry win over the stem rule', async () => {
    // `emetics`, `ascites` and `chelators` are rows themselves.
    expect(await expand('emetics are listed')).toBe('emmetiks are listed');
    expect(await expand('ascites was tapped')).toBe('asytees was tapped');
    expect(await expand('chelators bind iron')).toBe('keelators bind iron');
  });

  it('never strips a word of four letters or fewer', async () => {
    for (const word of ['gas', 'news', 'beds', 'ARDS']) {
      expect(await expand(`${word} was noted`)).toBe(`${word} was noted`);
    }
  });

  it('leaves a plural alone when the stem has no row', async () => {
    for (const word of ['patients', 'dosages', 'placebos', 'illness']) {
      expect(await expand(`the ${word} improved`)).toBe(`the ${word} improved`);
    }
  });
});

describe('native Kokoro (model lexicon consulted first)', () => {
  const known = JSON.parse(rawNativeKnown) as string[];

  it('is a sorted, unique list of ids that exist', () => {
    expect(known.length).toBeGreaterThan(0);
    expect(new Set(known).size).toBe(known.length);
    const sorted = [...known].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    expect(known).toEqual(sorted);
    const ids = new Set(BUILTIN_LEXICON.map((e) => e.id));
    for (const id of known) expect(ids.has(id)).toBe(true);
  });

  it('skips the rows the model lexicon already pronounces', async () => {
    native.value = true;
    expect(await expand('adenosine was given', 'kokoro')).toBe('adenosine was given');
    expect(await expand('tetracycline was stopped', 'kokoro')).toBe('tetracycline was stopped');
    expect(await expand('Nifedipine 10 mg', 'kokoro')).toBe('Nifedipine 10 milligrams');
  });

  it('still applies the rows it does not know', async () => {
    native.value = true;
    expect(await expand('quetiapine at night', 'kokoro')).toBe('quetiapeen at night');
    expect(await expand('capecitabine tablets', 'kokoro')).toBe('capecitabeen tablets');
  });

  it('keeps an -ine row whose lexicon pronunciation is still /aɪn/', async () => {
    native.value = true;
    // Present, but the model lexicon ends it /ˌaɪn/: the row is still the fix.
    expect(await expand('acetylcholine receptors', 'kokoro')).toBe('asetilcholene receptors');
  });

  it('applies every row without an engine id and on the web build', async () => {
    expect(await expand('adenosine was given')).toBe('adenoseene was given');
    expect(await expand('adenosine was given', 'kokoro')).toBe('adenoseene was given');
  });

  it('caches the two variants side by side', async () => {
    native.value = true;
    expect(await expand('adenosine', 'kokoro')).toBe('adenosine');
    native.value = false;
    expect(await expand('adenosine', 'kokoro')).toBe('adenoseene');
    native.value = true;
    expect(await expand('adenosine', 'kokoro')).toBe('adenosine');
  });

  it('still respells a plural of a skipped stem', async () => {
    // The model lexicon is keyed by the exact token, so it does not hold the
    // plural even when it holds the stem.
    native.value = true;
    expect(await expand('tetracyclines were stopped', 'kokoro')).toBe('tetracycleens were stopped');
    expect(await expand('the doxycycline\u2019s half-life', 'kokoro')).toBe(
      'the doxycycleen\u2019s half-life',
    );
  });

  it('leaves the lexicon version alone', async () => {
    const before = await lexiconVersion();
    native.value = true;
    expect(await expand('adenosine', 'kokoro')).toBe('adenosine');
    expect(await lexiconVersion()).toBe(before);
  });
});
