import { describe, expect, it } from 'vitest';
import { makePdf } from './__fixtures__/makePdf';
import { parsePdf } from './pdf';

const SAMPLE = {
  head: 'British Journal of Pharmacology',
  body: [
    'Thiazides act on the distal convoluted tubule.',
    'They lower blood pressure by increasing sodium loss.',
    'A dose of 12.5 mg once daily is usual.',
    'Hydrochlorothiazide and indapamide are examples.',
  ],
};

describe('parsePdf', () => {
  it('extracts the body text and drops the running head and page number', { timeout: 60_000 }, async () => {
    const data = makePdf([
      { ...SAMPLE, number: 1 },
      { ...SAMPLE, number: 2 },
    ]);

    const parsed = await parsePdf(data, 'fallback title');

    expect(parsed.pageCount).toBe(2);
    const text = parsed.doc.chapters
      .flatMap((chapter) => chapter.blocks.flatMap((block) => block.sentences.map((sentence) => sentence.text)))
      .join(' ');

    expect(text).toContain('Thiazides act on the distal convoluted tubule.');
    expect(text).toContain('12.5 mg once daily');
    expect(text).not.toContain('British Journal of Pharmacology');
    expect(parsed.doc.chapters.length).toBeGreaterThan(0);
  });

  it('reports progress once per page', { timeout: 60_000 }, async () => {
    const data = makePdf([1, 2, 3].map((number) => ({ ...SAMPLE, number })));
    const seen: [number, number][] = [];

    await parsePdf(data, 'progress', (done, total) => seen.push([done, total]));

    expect(seen).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('uses the document title from the metadata when there is one', { timeout: 60_000 }, async () => {
    const parsed = await parsePdf(makePdf([{ ...SAMPLE, number: 1 }]), 'renal-handout');

    expect(parsed.doc.format).toBe('pdf');
    expect(parsed.doc.title).toBeTruthy();
    expect(parsed.charsPerPage).toBeGreaterThan(50);
  });
});
