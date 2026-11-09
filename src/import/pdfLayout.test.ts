import { describe, expect, it } from 'vitest';
import {
  chaptersFromPages,
  dropPageFurniture,
  itemsToLines,
  pagesToParagraphs,
  rectsForRange,
  type PdfLine,
  type PdfPage,
  type PdfParagraph,
  type PdfTextItem,
} from './pdfLayout';

const item = (str: string, x: number, y: number, w = 40, h = 12): PdfTextItem => ({ str, x, y, w, h });
const line = (text: string, y: number, h = 12): PdfLine => ({
  text,
  x: 50,
  y,
  w: 400,
  h,
  items: [item(text, 50, y, 400, h)],
});
const page = (lines: PdfLine[], height = 800): PdfPage => ({ width: 600, height, lines });
const paragraph = (pageNumber: number, text: string): PdfParagraph => ({ page: pageNumber, text, spans: [] });

describe('itemsToLines', () => {
  it('puts items on the same row into one line with gap spaces', () => {
    const lines = itemsToLines([item('Hello', 10, 20, 40), item('world', 56, 20, 35)]);

    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('Hello world');
    expect(lines[0]?.x).toBe(10);
  });

  it('starts a new line when the row changes', () => {
    const lines = itemsToLines([item('Top row', 10, 20), item('Bottom row', 10, 60)]);

    expect(lines.map((current) => current.text)).toEqual(['Top row', 'Bottom row']);
  });

  it('ignores blank items', () => {
    expect(itemsToLines([item('   ', 10, 20), item('Real', 10, 20)])).toHaveLength(1);
  });
});

describe('dropPageFurniture', () => {
  it('removes the running header and page numbers in the top/bottom 8%', () => {
    const pages = [1, 2, 3, 4].map((number) =>
      page([line('Pharma Review', 10), line(`Body text ${number}`, 300), line(`Page ${number}`, 780)]),
    );

    const cleaned = dropPageFurniture(pages);
    const remaining = cleaned.map((current) => current.lines.map((entry) => entry.text));

    expect(remaining).toEqual([
      ['Body text 1'],
      ['Body text 2'],
      ['Body text 3'],
      ['Body text 4'],
    ]);
  });

  it('keeps body text that happens to repeat', () => {
    const pages = [page([line('Repeated sentence.', 300)]), page([line('Repeated sentence.', 300)])];

    expect(dropPageFurniture(pages)[0]?.lines).toHaveLength(1);
  });
});

describe('pagesToParagraphs', () => {
  it('joins wrapped lines and de-hyphenates a broken word', () => {
    const pages = [
      page([line('pharma-', 100), line('cology is fun.', 114), line('Second paragraph.', 220)]),
    ];

    const paragraphs = pagesToParagraphs(pages);

    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]?.text).toBe('pharmacology is fun.');
    expect(paragraphs[0]?.page).toBe(1);
    expect(paragraphs[1]?.text).toBe('Second paragraph.');
  });

  it('adds a space between lines that are not hyphenated', () => {
    const paragraphs = pagesToParagraphs([page([line('First half', 100), line('second half.', 114)])]);

    expect(paragraphs[0]?.text).toBe('First half second half.');
  });

  it('starts a fresh paragraph on each page', () => {
    const paragraphs = pagesToParagraphs([
      page([line('Starts here', 700)]),
      page([line('continues there.', 700)]),
    ]);

    expect(paragraphs.map((current) => current.page)).toEqual([1, 2]);
  });
});

describe('rectsForRange', () => {
  const withSpans: PdfParagraph = {
    page: 3,
    text: 'Alpha beta. Gamma delta.',
    spans: [
      { start: 0, end: 5, item: item('Alpha', 10, 100, 40) },
      { start: 5, end: 11, item: item(' beta.', 52, 100, 45) },
      { start: 12, end: 17, item: item('Gamma', 10, 120, 50) },
      { start: 17, end: 24, item: item(' delta.', 62, 120, 45) },
    ],
  };

  it('merges the items of one line into a single rect on the paragraph page', () => {
    const rects = rectsForRange(withSpans, 0, 11);

    expect(rects).toEqual([{ page: 3, x: 10, y: 100, w: 87, h: 12 }]);
  });

  it('returns one rect per line for a sentence spanning two lines', () => {
    const rects = rectsForRange(withSpans, 0, 24);

    expect(rects).toHaveLength(2);
    expect(rects[0]).toMatchObject({ page: 3, x: 10, y: 100, w: 87 });
    expect(rects[1]).toMatchObject({ page: 3, x: 10, y: 120, w: 97 });
  });

  it('returns nothing when the range misses every item', () => {
    expect(rectsForRange({ page: 1, text: '', spans: [] }, 0, 5)).toEqual([]);
  });
});

describe('chaptersFromPages', () => {
  const paragraphs = [
    paragraph(1, 'Preface text.'),
    paragraph(2, 'Chapter two starts here. It has two sentences.'),
    paragraph(21, 'Late chapter text.'),
  ];

  it('uses outline starts and keeps the pages before the first entry', () => {
    const chapters = chaptersFromPages(paragraphs.slice(0, 2), [{ page: 2, title: 'Chapter Two' }], 2);

    expect(chapters.map((chapter) => chapter.title)).toEqual(['Pages 1\u20131', 'Chapter Two']);
    expect(chapters[0]?.blocks[0]?.sentences[0]?.id).toBe('0-0-0');
    expect(chapters[1]?.blocks[0]?.sentences.map((sentence) => sentence.id)).toEqual(['1-0-0', '1-0-1']);
    expect(chapters[1]?.blocks[0]?.sentences[0]?.pdfRects).toEqual([]);
  });

  it('falls back to one chapter per 20 pages', () => {
    const chapters = chaptersFromPages(paragraphs, [], 40);

    expect(chapters.map((chapter) => chapter.title)).toEqual(['Pages 1\u201320', 'Pages 21\u201340']);
    expect(chapters[0]?.blocks[0]?.sentences[0]?.text).toBe('Preface text.');
    expect(chapters[1]?.blocks[0]?.sentences[0]?.text).toBe('Late chapter text.');
  });

  it('attaches rects to the sentences they cover', () => {
    const withRects: PdfParagraph = {
      page: 1,
      text: 'Alpha beta. Gamma.',
      spans: [
        { start: 0, end: 5, item: item('Alpha', 10, 100, 40) },
        { start: 5, end: 11, item: item(' beta.', 52, 100, 45) },
        { start: 12, end: 18, item: item('Gamma.', 10, 120, 45) },
      ],
    };

    const sentences = chaptersFromPages([withRects], [{ page: 1, title: 'One' }], 1)[0]?.blocks[0]?.sentences;

    expect(sentences?.map((sentence) => sentence.text)).toEqual(['Alpha beta.', 'Gamma.']);
    expect(sentences?.[0]?.pdfRects?.[0]).toMatchObject({ page: 1, x: 10, y: 100, w: 87 });
    expect(sentences?.[1]?.pdfRects?.[0]).toMatchObject({ page: 1, y: 120 });
  });
});
