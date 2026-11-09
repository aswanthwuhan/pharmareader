import { describe, expect, it } from 'vitest';
import { speakPlan, spokenText } from './spoken';

const CITATIONS = { citations: true, brackets: false };
const EVERYTHING = { citations: true, brackets: true };
const NOTHING = { citations: false, brackets: false };

/** The promise the index map makes: every spoken character is a real one. */
function expectFaithful(original: string, spoken: string, map: number[] | null): void {
  expect(spoken.length).toBeGreaterThan(0);
  if (map === null) {
    expect(spoken).toBe(original);
    return;
  }
  expect(map).toHaveLength(spoken.length);
  for (let i = 0; i < spoken.length; i++) {
    expect(original[map[i]!]).toBe(spoken[i]);
  }
}

describe('speakPlan', () => {
  it('leaves the sentence alone when nothing is stripped', () => {
    expect(speakPlan('Aspirin works [12].', NOTHING)).toEqual({ text: 'Aspirin works [12].', charMap: null });
  });

  it('drops numeric citations', () => {
    expect(spokenText('Aspirin works [12].', CITATIONS)).toBe('Aspirin works.');
    expect(spokenText('Trials [12, 15] agree.', CITATIONS)).toBe('Trials agree.');
    expect(spokenText('Rates [3–5] differ.', CITATIONS)).toBe('Rates differ.');
  });

  it('drops author–year citations', () => {
    expect(spokenText('Metformin (Smith et al., 2019) lowers glucose.', CITATIONS)).toBe(
      'Metformin lowers glucose.',
    );
    expect(spokenText('It works (Smith, 2019; Jones & Co., 2020).', CITATIONS)).toBe('It works.');
  });

  it('keeps a dose in parentheses that is not a citation', () => {
    expect(spokenText('Give 2 mg (twice daily) with food.', CITATIONS)).toBe('Give 2 mg (twice daily) with food.');
    expect(spokenText('See (Fig. 2) for the curve.', CITATIONS)).toBe('See (Fig. 2) for the curve.');
  });

  it('drops every aside when brackets are switched off too', () => {
    expect(spokenText('Give 2 mg (twice daily) with food.', EVERYTHING)).toBe('Give 2 mg with food.');
  });

  it('does not leave a double space or a space before punctuation', () => {
    expect(spokenText('A [1] B', CITATIONS)).toBe('A B');
    expect(spokenText('Works [12] .', CITATIONS)).toBe('Works.');
    expect(spokenText('Works [12].', CITATIONS)).toBe('Works.');
  });

  it('maps every spoken character back to the original sentence', () => {
    const original = 'Metformin (Smith et al., 2019) lowers glucose [12].';
    const plan = speakPlan(original, CITATIONS);
    expect(plan.text).toBe('Metformin lowers glucose.');
    expectFaithful(original, plan.text, plan.charMap);
    // "lowers" starts at 31 in the original; the map has to say so.
    expect(plan.charMap?.[plan.text.indexOf('lowers')]).toBe(original.indexOf('lowers'));
  });

  it('falls back to the original when stripping would leave nothing', () => {
    expect(speakPlan('[12]', CITATIONS)).toEqual({ text: '[12]', charMap: null });
    expect(speakPlan('(a)', EVERYTHING)).toEqual({ text: '(a)', charMap: null });
  });

  it('keeps the map faithful for a mixed sentence with brackets on', () => {
    const original = 'Warfarin (Coumadin) needs INR checks [3].';
    const plan = speakPlan(original, EVERYTHING);
    expect(plan.text).toBe('Warfarin needs INR checks.');
    expectFaithful(original, plan.text, plan.charMap);
  });
});
