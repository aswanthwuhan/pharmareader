import { describe, expect, it } from 'vitest';
import { alignTimings, transcriptFromChunks } from './align';
import { estimateTimings, keyForms, words } from './text';
import type { TranscriptWord, WordTiming } from './types';

/** Transcript as Whisper reports it: one word per chunk, times in ms. */
function heard(list: [string, number, number][]): TranscriptWord[] {
  return list.map(([text, startMs, endMs]) => ({ text, startMs, endMs }));
}

/**
 * Everything the reader relies on: one timing per word of the original text,
 * inside the clip, and a highlight that only moves forward.
 */
function expectSaneTimings(timings: WordTiming[], text: string, durationMs: number): void {
  const ranges = words(text);
  expect(timings).toHaveLength(ranges.length);
  let previousStart = 0;
  timings.forEach((timing, index) => {
    const range = ranges[index]!;
    expect({ charStart: timing.charStart, charEnd: timing.charEnd }).toEqual(range);
    expect(timing.startMs).toBeGreaterThanOrEqual(0);
    expect(timing.startMs).toBeLessThanOrEqual(durationMs);
    expect(timing.endMs).toBeGreaterThanOrEqual(timing.startMs);
    expect(timing.endMs).toBeLessThanOrEqual(durationMs);
    expect(timing.startMs).toBeGreaterThanOrEqual(previousStart);
    previousStart = timing.startMs;
  });
}

describe('transcriptFromChunks', () => {
  it('keeps one entry per word chunk', () => {
    const wordsOut = transcriptFromChunks([
      { text: ' Digoxin', startMs: 0, endMs: 480 },
      { text: ' has', startMs: 480, endMs: 700 },
    ]);
    expect(wordsOut).toEqual([
      { text: 'Digoxin', startMs: 0, endMs: 480 },
      { text: 'has', startMs: 480, endMs: 700 },
    ]);
  });

  it('splits a chunk carrying several words and shares its span', () => {
    const wordsOut = transcriptFromChunks([{ text: ' half-life', startMs: 800, endMs: 1400 }]);
    // "half-life" is one token here (no space): the recogniser writes it joined.
    expect(wordsOut).toHaveLength(1);

    const split = transcriptFromChunks([{ text: ' blood pressure', startMs: 0, endMs: 1000 }]);
    expect(split.map((word) => word.text)).toEqual(['blood', 'pressure']);
    expect(split[0]!.startMs).toBe(0);
    expect(split[1]!.endMs).toBe(1000);
    // Split by length: "blood" (5+1) of 15 characters, so "pressure" starts at 400.
    expect(split[1]!.startMs).toBeCloseTo(400, 5);
  });

  it('drops chunks without a span', () => {
    expect(transcriptFromChunks([{ text: ' hm', startMs: 500, endMs: 500 }])).toEqual([]);
  });
});

describe('alignTimings', () => {
  it('hands each word the span the recogniser heard', () => {
    const text = 'Digoxin has a half-life';
    const transcript = heard([
      ['Digoxin', 0, 500],
      ['has', 500, 700],
      ['a', 700, 780],
      ['half', 780, 1050],
      ['life', 1050, 1400],
    ]);

    const timings = alignTimings(text, transcript, 2600);

    expectSaneTimings(timings, text, 2600);
    expect(timings[0]).toMatchObject({ startMs: 0, endMs: 500 });
    expect(timings[1]).toMatchObject({ startMs: 500, endMs: 700 });
    expect(timings[2]).toMatchObject({ startMs: 700, endMs: 780 });
    // "half-life" is one word on screen and two in the transcript.
    expect(timings[3]).toMatchObject({ startMs: 780, endMs: 1400 });
  });

  it('matches a spelled-out acronym to the word it belongs to', () => {
    const text = 'CYP3A4 inhibits CYP2D6';
    const transcript = heard([
      ['C', 0, 120],
      ['Y', 120, 240],
      ['P', 240, 360],
      ['three', 360, 600],
      ['A', 600, 720],
      ['four', 720, 900],
      ['inhibits', 900, 1300],
      ['C', 1300, 1420],
      ['Y', 1420, 1540],
      ['P', 1540, 1660],
      ['two', 1660, 1850],
      ['D', 1850, 1970],
      ['six', 1970, 2200],
    ]);

    const timings = alignTimings(text, transcript, 2200);

    expectSaneTimings(timings, text, 2200);
    expect(timings[0]).toMatchObject({ startMs: 0, endMs: 900 });
    expect(timings[1]).toMatchObject({ startMs: 900, endMs: 1300 });
    expect(timings[2]).toMatchObject({ startMs: 1300, endMs: 2200 });
  });

  it('reads digits as either digits or a number', () => {
    // The sentence says "10"; the voice says "ten" and the recogniser writes it back as a word.
    const text = 'Take 10 mg';
    const transcript = heard([
      ['Take', 0, 300],
      ['ten', 300, 700],
      ['milligrams', 700, 1200],
    ]);

    const timings = alignTimings(text, transcript, 1400);

    expectSaneTimings(timings, text, 1400);
    expect(timings[1]).toMatchObject({ startMs: 300, endMs: 700 });
    expect(timings[2]).toMatchObject({ startMs: 700, endMs: 1200 });
  });

  it('gives a word the recogniser missed the time between its neighbours', () => {
    const text = 'The patient had hypoglycemia';
    const transcript = heard([
      ['The', 0, 200],
      ['had', 500, 700],
      ['hypoglycemia', 700, 1300],
    ]);

    const timings = alignTimings(text, transcript, 1500);

    expectSaneTimings(timings, text, 1500);
    expect(timings[0]).toMatchObject({ startMs: 0, endMs: 200 });
    // Between "The" (ends 200) and "had" (starts 500).
    expect(timings[1]!.startMs).toBeCloseTo(200, 0);
    expect(timings[1]!.endMs).toBeCloseTo(500, 0);
    expect(timings[2]).toMatchObject({ startMs: 500, endMs: 700 });
  });

  it('gives a word the recogniser merged with its neighbour a share of that span', () => {
    const text = 'can not';
    const transcript = heard([['cannot', 100, 700]]);

    const timings = alignTimings(text, transcript, 1000);

    expectSaneTimings(timings, text, 1000);
    // The model cannot know which of the two was said first: one takes the
    // heard word, the other the space after it, so the highlight still moves.
    expect(timings[0]!.startMs).toBe(100);
    expect(timings[0]!.endMs).toBe(700);
    expect(timings[1]!.startMs).toBe(700);
    expect(timings[1]!.endMs).toBe(1000);
  });

  it('interpolates a word the lexicon expanded beyond recognition', () => {
    const text = 't½ is short';
    const transcript = heard([
      ['half', 0, 260],
      ['life', 260, 640],
      ['is', 640, 800],
      ['short', 800, 1200],
    ]);

    const timings = alignTimings(text, transcript, 1300);

    expectSaneTimings(timings, text, 1300);
    // "t½" is read as "half life", so it takes both heard words…
    expect(timings[0]).toMatchObject({ startMs: 0, endMs: 640 });
    expect(timings[1]).toMatchObject({ startMs: 640, endMs: 800 });
    expect(timings[2]).toMatchObject({ startMs: 800, endMs: 1200 });
  });

  it('interpolates a leading word and a trailing word', () => {
    const text = 'alpha beta gamma';
    const transcript = heard([['beta', 300, 600]]);

    const timings = alignTimings(text, transcript, 1000);

    expectSaneTimings(timings, text, 1000);
    expect(timings[0]).toMatchObject({ startMs: 0, endMs: 300 });
    expect(timings[1]).toMatchObject({ startMs: 300, endMs: 600 });
    expect(timings[2]).toMatchObject({ startMs: 600, endMs: 1000 });
  });

  it('falls back to the estimate when the transcript explains nothing', () => {
    const text = 'Digoxin has a half-life';
    const timings = alignTimings(text, heard([['Hello', 0, 400], ['world', 400, 900]]), 1000);
    expect(timings).toEqual(estimateTimings(text, 1000));
  });

  it('falls back to the estimate on an empty transcript or clip', () => {
    const text = 'Digoxin has a half-life';
    expect(alignTimings(text, [], 1000)).toEqual(estimateTimings(text, 1000));
    expect(alignTimings(text, heard([['Digoxin', 0, 100]]), 0)).toEqual(estimateTimings(text, 0));
  });

  it('returns nothing for an empty sentence', () => {
    expect(alignTimings('', heard([['word', 0, 100]]), 1000)).toEqual([]);
    expect(alignTimings('   ', heard([['word', 0, 100]]), 1000)).toEqual([]);
  });

  it('ignores the recogniser repeating a word and keeps moving forward', () => {
    const text = 'Digoxin has a half-life';
    const transcript = heard([
      ['Digoxin', 0, 400],
      ['Digoxin', 400, 800],
      ['has', 800, 1000],
      ['a', 1000, 1060],
      ['half', 1060, 1400],
      ['life', 1400, 1800],
    ]);

    const timings = alignTimings(text, transcript, 2000);

    expectSaneTimings(timings, text, 2000);
    expect(timings[0]).toMatchObject({ startMs: 0 });
    expect(timings[3]!.endMs).toBeGreaterThan(1400);
  });

  it('clamps timings that run past the clip', () => {
    const text = 'one two';
    // Whisper pads the last token past the audio in quiet clips.
    const timings = alignTimings(text, heard([['one', 0, 500], ['two', 500, 2600]]), 2000);
    expectSaneTimings(timings, text, 2000);
    expect(timings[1]!.endMs).toBe(2000);
  });
});

describe('keyForms', () => {
  it('spells digits one by one and as a number', () => {
    expect(keyForms('10')).toEqual(['onezero', 'ten']);
    expect(keyForms('3.5')).toEqual(['threepointfive', 'threepointfive']);
    expect(keyForms('CYP3A4')).toEqual(['cypthreeafour', 'cypthreeafour']);
  });

  it('normalises punctuation, accents and symbols', () => {
    expect(keyForms('half-life,')).toEqual(['halflife', 'halflife']);
    // The same drug name, spelled the British way, must still be the same word.
    expect(keyForms('hypoglycæmia')).toEqual(['hypoglycaemia', 'hypoglycaemia']);
    expect(keyForms('50%')).toEqual(['fivezeropercent', 'fiftypercent']);
    expect(keyForms('t½')).toEqual(['thalf', 'thalf']);
  });
});
