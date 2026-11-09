import { describe, expect, it } from 'vitest';
import { makeSentences, segmentText, splitSentences } from './segment';

describe('segmentText', () => {
  it('splits plain sentences and keeps source offsets', () => {
    const spans = segmentText('One. Two.');

    expect(spans.map((span) => span.text)).toEqual(['One.', 'Two.']);
    expect(spans.map((span) => span.index)).toEqual([0, 5]);
  });

  it('trims whitespace around each sentence', () => {
    expect(splitSentences('  First point.   Second point.  ')).toEqual(['First point.', 'Second point.']);
  });

  it('never splits inside a decimal', () => {
    const sentences = splitSentences('The volume is 0.5 L. The dose was 2.5 mg/kg after that.');

    expect(sentences).toEqual(['The volume is 0.5 L.', 'The dose was 2.5 mg/kg after that.']);
    expect(sentences.some((sentence) => /^\d/.test(sentence))).toBe(false);
  });

  it('keeps a sentence going after a trailing abbreviation', () => {
    const sentences = splitSentences(
      'Give 0.5 mg of drug. The dose is 2.5 mg/kg i.v. Dr. Sharma said so.',
    );

    expect(sentences).toEqual([
      'Give 0.5 mg of drug.',
      'The dose is 2.5 mg/kg i.v. Dr. Sharma said so.',
    ]);
  });

  it('keeps "Fig. 3" with its sentence', () => {
    expect(splitSentences('See Fig. 3. The figure shows binding.')).toEqual([
      'See Fig. 3.',
      'The figure shows binding.',
    ]);
  });

  it('keeps e.g. and et al. inside the sentence', () => {
    expect(
      splitSentences('Common drugs, e.g. aspirin and ibuprofen, are used (Smith et al. 2020). Next step.'),
    ).toEqual(['Common drugs, e.g. aspirin and ibuprofen, are used (Smith et al. 2020).', 'Next step.']);
  });

  it('does not break after a dotted Latin abbreviation such as p.o. or b.i.d.', () => {
    expect(splitSentences('The infusion is 2 mg/hr, p.o. twice daily. Monitor closely.')).toEqual([
      'The infusion is 2 mg/hr, p.o. twice daily.',
      'Monitor closely.',
    ]);
  });

  it('returns nothing for blank input', () => {
    expect(splitSentences('   ')).toEqual([]);
  });
});

describe('makeSentences', () => {
  it('uses deterministic ${chapter}-${block}-${sentence} ids', () => {
    const sentences = makeSentences('First. Second.', 2, 1);

    expect(sentences.map((sentence) => sentence.id)).toEqual(['2-1-0', '2-1-1']);
    expect(sentences.map((sentence) => sentence.text)).toEqual(['First.', 'Second.']);
  });

  it('collapses whitespace and drops chunks without letters or digits', () => {
    expect(makeSentences('  A   sentence   here.  ', 0, 0)[0]).toMatchObject({
      id: '0-0-0',
      text: 'A sentence here.',
    });
    expect(makeSentences('--- \u2014\u2014 ***', 0, 0)).toEqual([]);
  });
});
