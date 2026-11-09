import { describe, expect, it } from 'vitest';
import type { ParsedDoc, PdfRect } from '../core/types';
import { firstPosOnPages, indexBook, lastPage, pageWithSentence } from './sentences';

function rect(page: number): PdfRect {
  return { page, x: 0, y: 0, w: 10, h: 10 };
}

const doc: ParsedDoc = {
  title: 'Paper',
  format: 'pdf',
  chapters: [
    {
      id: 'ch-0',
      title: 'Introduction',
      blocks: [
        {
          id: 'b0',
          kind: 'p',
          sentences: [
            { id: 's1', text: 'First page.', pdfRects: [rect(1)] },
            { id: 's2', text: 'Still page one.', pdfRects: [rect(1), rect(2)] },
            { id: 's3', text: 'Page three.', pdfRects: [rect(3)] },
          ],
        },
      ],
    },
    {
      id: 'ch-1',
      title: 'Results',
      blocks: [
        {
          id: 'b1',
          kind: 'p',
          sentences: [{ id: 's4', text: 'Also page three.', pdfRects: [rect(3)] }],
        },
        {
          id: 'b2',
          kind: 'p',
          sentences: [{ id: 's5', text: 'Page five.', pdfRects: [rect(5)] }],
        },
      ],
    },
  ],
};

describe('PDF page navigation', () => {
  it('finds the first sentence printed on each page', () => {
    const pages = firstPosOnPages(indexBook(doc));
    expect(pages.get(1)).toEqual({ chapterIndex: 0, index: 0 });
    expect(pages.get(3)).toEqual({ chapterIndex: 0, index: 2 });
    expect(pages.get(5)).toEqual({ chapterIndex: 1, index: 1 });
    // Page 2 starts mid-sentence; it has no first sentence of its own.
    expect(pages.has(2)).toBe(false);
  });

  it('reports the last page the document reaches', () => {
    expect(lastPage(indexBook(doc))).toBe(5);
  });

  it('skips pages that carry no sentence when turning forward or back', () => {
    const pages = firstPosOnPages(indexBook(doc));
    expect(pageWithSentence(pages, 3, 1)).toBe(5);
    expect(pageWithSentence(pages, 3, -1)).toBe(1);
    expect(pageWithSentence(pages, 1, -1)).toBeNull();
    expect(pageWithSentence(pages, 5, 1)).toBeNull();
  });
});
