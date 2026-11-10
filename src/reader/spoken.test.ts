import { describe, expect, it } from 'vitest';
import { speakPlan, spokenText, type SpeakOptions } from './spoken';

const CITATIONS: SpeakOptions = { citations: true, brackets: 'read' };
const NOTHING: SpeakOptions = { citations: false, brackets: 'read' };
const ANNOUNCE: SpeakOptions = { citations: true, brackets: 'announce' };
const SKIP: SpeakOptions = { citations: true, brackets: 'skip' };

/**
 * The promise the index map makes: `charMap[i]` points at a real character in
 * the original, never runs backwards, and covers the whole spoken text — so a
 * word highlight or a selection offset lands on the text the reader sees.
 */
function expectMapped(original: string, plan: { text: string; charMap: number[] | null }): void {
  expect(plan.text.length).toBeGreaterThan(0);
  if (plan.charMap === null) {
    expect(plan.text).toBe(original);
    return;
  }
  expect(plan.charMap).toHaveLength(plan.text.length);
  let previous = 0;
  for (const at of plan.charMap) {
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(original.length);
    expect(at).toBeGreaterThanOrEqual(previous);
    previous = at;
  }
}

/** The words kept from the sentence still point at themselves, character for character. */
function expectWordsMapped(
  original: string,
  plan: { text: string; charMap: number[] | null },
  words: string[]
): void {
  expect(plan.charMap).not.toBeNull();
  for (const word of words) {
    const at = plan.text.indexOf(word);
    expect(at, word).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < word.length; i++) {
      expect(original[plan.charMap![at + i]!], `${word}[${i}]`).toBe(word[i]);
    }
  }
}

describe('speakPlan: citations', () => {
  it('leaves the sentence alone when nothing applies', () => {
    expect(speakPlan('Aspirin works [12].', NOTHING)).toEqual({ text: 'Aspirin works [12].', charMap: null });
  });

  it('drops numeric citations', () => {
    expect(spokenText('Aspirin works [12].', CITATIONS)).toBe('Aspirin works.');
    expect(spokenText('Trials [12, 15] agree.', CITATIONS)).toBe('Trials agree.');
    expect(spokenText('Rates [3–5] differ.', CITATIONS)).toBe('Rates differ.');
  });

  it('drops author–year citations', () => {
    expect(spokenText('Metformin (Smith et al., 2019) lowers glucose.', CITATIONS)).toBe(
      'Metformin lowers glucose.'
    );
    expect(spokenText('It works (Smith, 2019; Jones & Co., 2020).', CITATIONS)).toBe('It works.');
  });

  it('keeps a dose in parentheses that is not a citation', () => {
    expect(spokenText('Give 2 mg (twice daily) with food.', CITATIONS)).toBe(
      'Give 2 mg (twice daily) with food.'
    );
    expect(spokenText('See (Fig. 2) for the curve.', CITATIONS)).toBe('See (Fig. 2) for the curve.');
  });

  it('keeps citations untouched when the citation switch is off', () => {
    expect(spokenText('Metformin (Smith et al., 2019) lowers glucose.', { citations: false, brackets: 'announce' })).toBe(
      'Metformin (Smith et al., 2019) lowers glucose.'
    );
    expect(spokenText('It works [12].', { citations: false, brackets: 'skip' })).toBe('It works [12].');
  });

  it('never announces a citation as an aside', () => {
    expect(spokenText('Metformin (Smith et al., 2019) lowers glucose.', ANNOUNCE)).toBe(
      'Metformin lowers glucose.'
    );
    expect(spokenText('Trials agree (Smith, 2019).', ANNOUNCE)).toBe('Trials agree.');
  });

  it('does not leave a double space or a space before punctuation', () => {
    expect(spokenText('A [1] B', CITATIONS)).toBe('A B');
    expect(spokenText('Works [12] .', CITATIONS)).toBe('Works.');
    expect(spokenText('Works [12].', CITATIONS)).toBe('Works.');
  });
});

describe('speakPlan: brackets, announce', () => {
  it('names a short acronym right after a phrase', () => {
    expect(spokenText('The autonomic nervous system (ANS) controls the gut.', ANNOUNCE)).toBe(
      'The autonomic nervous system, ANS in brackets, controls the gut.'
    );
  });

  it('keeps the acronym as one token, so the lexicon can still spell it out', () => {
    const plan = speakPlan('The autonomic nervous system (ANS) controls the gut.', ANNOUNCE);
    expect(plan.text).toContain('ANS in brackets');
  });

  it('announces a drug-metabolism acronym with digits', () => {
    expect(spokenText('Metabolised by cytochrome P450 (CYP3A4) enzymes.', ANNOUNCE)).toBe(
      'Metabolised by cytochrome P450, CYP3A4 in brackets, enzymes.'
    );
  });

  it('announces a Greek-letter aside as an aside, not an acronym', () => {
    expect(spokenText('The effect (β-blocker) is weak.', ANNOUNCE)).toBe(
      'The effect, in brackets, β-blocker, close bracket, is weak.'
    );
  });

  it('announces a short explanation', () => {
    expect(spokenText('Digoxin (a cardiac glycoside) slows conduction.', ANNOUNCE)).toBe(
      'Digoxin, in brackets, a cardiac glycoside, close bracket, slows conduction.'
    );
  });

  it('announces an example', () => {
    expect(spokenText('Give (e.g. atropine) for bradycardia.', ANNOUNCE)).toBe(
      'Give, in brackets, e.g. atropine, close bracket, for bradycardia.'
    );
  });

  it('announces a cross-reference', () => {
    expect(spokenText('See (Fig. 2) for the curve.', ANNOUNCE)).toBe(
      'See, in brackets, Fig. 2, close bracket, for the curve.'
    );
  });

  it('announces square brackets that are not citations', () => {
    expect(spokenText('It works [as above].', ANNOUNCE)).toBe(
      'It works, in brackets, as above, close bracket.'
    );
  });

  it('announces a square-bracket acronym', () => {
    expect(spokenText('The system [ANS] acts.', ANNOUNCE)).toBe(
      'The system, ANS in brackets, acts.'
    );
  });

  it('announces doses in brackets too', () => {
    expect(spokenText('Give 5 mg/kg (bolus) slowly.', ANNOUNCE)).toBe(
      'Give 5 mg/kg, in brackets, bolus, close bracket, slowly.'
    );
    expect(spokenText('A dose (5 mg/kg) is safe.', ANNOUNCE)).toBe(
      'A dose, in brackets, 5 mg/kg, close bracket, is safe.'
    );
  });

  it('announces an aside at the start of a sentence', () => {
    expect(spokenText('(See Fig. 2) Capsaicin activates TRPV1.', ANNOUNCE)).toBe(
      'In brackets, See Fig. 2, close bracket, Capsaicin activates TRPV1.'
    );
  });

  it('announces an aside at the end of a sentence without a trailing comma', () => {
    expect(spokenText('It acts on TRPV1 [as above].', ANNOUNCE)).toBe(
      'It acts on TRPV1, in brackets, as above, close bracket.'
    );
  });

  it('announces every bracket in a sentence with several', () => {
    expect(spokenText('A (b) and c (d) follow.', ANNOUNCE)).toBe(
      'A, in brackets, b, close bracket, and c, in brackets, d, close bracket, follow.'
    );
  });

  it('does not double the comma of a sentence that already has one', () => {
    expect(spokenText('Digoxin, (a glycoside) is used.', ANNOUNCE)).toBe(
      'Digoxin, in brackets, a glycoside, close bracket, is used.'
    );
  });

  it('never leaves a double space around the announcement', () => {
    expect(spokenText('A (b) c', ANNOUNCE)).toBe('A, in brackets, b, close bracket, c');
  });

  it('drops empty brackets instead of saying "close bracket" alone', () => {
    expect(spokenText('A () B', ANNOUNCE)).toBe('A B');
  });

  it('reads nested brackets as written', () => {
    const original = 'Dose (a (b) c) is high.';
    const plan = speakPlan(original, ANNOUNCE);
    expect(plan.text).toBe(original);
    expect(plan.charMap).toBeNull();
  });

  it('reads an unclosed bracket as written', () => {
    expect(spokenText('Dose (5 mg/kg', ANNOUNCE)).toBe('Dose (5 mg/kg');
    expect(spokenText('Trial (phase 2 (dose)', ANNOUNCE)).toBe('Trial (phase 2 (dose)');
  });

  it('leaves a stray closing bracket as a character', () => {
    expect(spokenText('Give 5 mg/kg) daily.', ANNOUNCE)).toBe('Give 5 mg/kg) daily.');
  });

  it('maps the announced words back to the original sentence', () => {
    const original = 'Autonomic nervous system (ANS) raises heart rate.';
    const plan = speakPlan(original, ANNOUNCE);
    expect(plan.text).toBe('Autonomic nervous system, ANS in brackets, raises heart rate.');
    expectMapped(original, plan);
    expectWordsMapped(original, plan, ['ANS', 'raises', 'heart']);
    // The words added after the aside point at its closing bracket.
    expect(plan.charMap?.[plan.text.indexOf('in brackets')]).toBe(original.indexOf(')'));
  });

  it('maps the announced words of an aside', () => {
    const original = 'Digoxin (a cardiac glycoside) slows conduction.';
    const plan = speakPlan(original, ANNOUNCE);
    expectMapped(original, plan);
    expectWordsMapped(original, plan, ['a cardiac glycoside', 'slows']);
  });
});

describe('speakPlan: brackets, read and skip', () => {
  it('reads brackets exactly as written in read mode', () => {
    const original = 'Give 2 mg (twice daily) with food.';
    expect(speakPlan(original, { citations: false, brackets: 'read' })).toEqual({
      text: original,
      charMap: null,
    });
  });

  it('drops parenthetical and square asides in skip mode', () => {
    expect(spokenText('Give 2 mg (twice daily) [as above] with food.', SKIP)).toBe(
      'Give 2 mg with food.'
    );
  });

  it('keeps citations untouched by skip mode when citations are off', () => {
    expect(spokenText('Metformin (Smith et al., 2019) is used.', { citations: false, brackets: 'skip' })).toBe(
      'Metformin (Smith et al., 2019) is used.'
    );
  });

  it('maps the kept words when asides are skipped', () => {
    const original = 'Warfarin (Coumadin) needs INR checks [3].';
    const plan = speakPlan(original, SKIP);
    expect(plan.text).toBe('Warfarin needs INR checks.');
    expectMapped(original, plan);
    expectWordsMapped(original, plan, ['Warfarin', 'needs', 'INR']);
  });

  it('falls back to the original when stripping would leave nothing', () => {
    expect(speakPlan('[12]', CITATIONS)).toEqual({ text: '[12]', charMap: null });
    expect(speakPlan('(a)', SKIP)).toEqual({ text: '(a)', charMap: null });
  });

  it('maps a word after a skipped aside to its real position', () => {
    const original = 'Give 2 mg (twice daily) with food.';
    const plan = speakPlan(original, SKIP);
    expect(plan.text).toBe('Give 2 mg with food.');
    expect(plan.charMap?.[plan.text.indexOf('with')]).toBe(original.indexOf('with'));
  });
});
