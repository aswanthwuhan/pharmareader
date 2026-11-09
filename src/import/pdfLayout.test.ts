import { describe, expect, it } from 'vitest';
import {
  chaptersFromPages,
  dropPageFurniture,
  itemsToLines,
  itemsToPageLines,
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
/** A line with its own left edge and width: headings, indents and centred titles need them. */
const placed = (text: string, x: number, y: number, w: number, h = 12): PdfLine => ({
  text,
  x,
  y,
  w,
  h,
  items: [item(text, x, y, w, h)],
});const paragraph = (pageNumber: number, text: string): PdfParagraph => ({ page: pageNumber, text, spans: [] });

describe('itemsToPageLines', () => {
  /** 20 rows of a two-column journal page: left column 40-280, right column 320-560. */
  const twoColumns = (rows = 20, rowHeight = 14): PdfTextItem[] => {
    const items: PdfTextItem[] = [];
    for (let row = 0; row < rows; row++) {
      const y = 100 + row * rowHeight;
      items.push(item(`left${row}`, 40, y, 240), item(`right${row}`, 320, y, 240));
    }
    return items;
  };

  it('reads the left column to the bottom before the right column', () => {
    const lines = itemsToPageLines(twoColumns(), 600);
    const texts = lines.map((current) => current.text);

    expect(texts.slice(0, 20)).toEqual(Array.from({ length: 20 }, (_, row) => `left${row}`));
    expect(texts.slice(20)).toEqual(Array.from({ length: 20 }, (_, row) => `right${row}`));
  });

  it('keeps a full-width title between the columns of its band', () => {
    const items = twoColumns(20);
    items.push(item('A full width title', 40, 233, 520));

    const texts = itemsToPageLines(items, 600).map((current) => current.text);
    const title = texts.indexOf('A full width title');

    const band = (rows: number[]) => [...rows.map((row) => `left${row}`), ...rows.map((row) => `right${row}`)];
    // Rows above the title: the whole left column, then the whole right one.
    expect(texts.slice(0, title)).toEqual(band([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(texts.slice(title + 1)).toEqual(band([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]));
  });

  it('leaves a single-column page in top-to-bottom order', () => {
    const items = Array.from({ length: 20 }, (_, row) => item(`line ${row}`, 50, 100 + row * 14, 500));

    expect(itemsToPageLines(items, 600).map((current) => current.text)).toEqual(
      Array.from({ length: 20 }, (_, row) => `line ${row}`),
    );
  });

  it('does not split a page whose text sits in one centred block', () => {
    const items = Array.from({ length: 20 }, (_, row) => item(`centred ${row}`, 200, 100 + row * 14, 200));

    expect(itemsToPageLines(items, 600)).toHaveLength(20);
  });
});

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

  it('breaks the paragraph where the reading order drops back to a new column', () => {
    // itemsToPageLines emits the whole left column, then the right one from the
    // top: y goes backwards at that point and must not be read as a continuation.
    const paragraphs = pagesToParagraphs([
      page([line('Left column sentence.', 100), line('Right column starts here.', 80)]),
    ]);

    expect(paragraphs.map((current) => current.text)).toEqual([
      'Left column sentence.',
      'Right column starts here.',
    ]);
  });

  it('still joins a word hyphenated across a column break', () => {
    const paragraphs = pagesToParagraphs([
      page([line('with complex interac-', 120), line('tions of innate immunity.', 80)]),
    ]);

    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]?.text).toBe('with complex interactions of innate immunity.');
  });

  it('starts a paragraph when the type size changes under a caption', () => {
    const paragraphs = pagesToParagraphs([
      page([line('Fig. 3 Effects on TSLP.', 560, 9), line('Body text continues here.', 572, 12)]),
    ]);

    expect(paragraphs).toHaveLength(2);
  });

  /** 12 pt type set on a 20.6 pt step, as in the NMC guidelines: gap / height = 1.7. */
  const LEADING = 20.64;

  it('keeps a paragraph whole when the leading is wider than the type', () => {
    // Comparing the gap with the *font height* reads every line as a paragraph
    // end here ("…high quality" | "health care and advance…", the reported bug).
    const paragraphs = pagesToParagraphs([
      page([
        placed(
          'The purpose of PG education is to create specialists who would provide high quality',
          50,
          100,
          400,
        ),
        placed('health care and advance the cause of science through research & training.', 50, 100 + LEADING, 330),
        placed('Pharmacology consists of both the experimental (basic) and clinical sciences.', 50, 182, 400),
      ]),
    ]);

    expect(paragraphs.map((current) => current.text)).toEqual([
      'The purpose of PG education is to create specialists who would provide high quality health care and advance the cause of science through research & training.',
      'Pharmacology consists of both the experimental (basic) and clinical sciences.',
    ]);
  });

  it('never ends a paragraph on a line that runs on in lower case', () => {
    // A wide gap below a line that has no full stop and continues in lower case
    // is uneven leading (a figure, an object in the way), not a paragraph end.
    const paragraphs = pagesToParagraphs([
      page([
        placed('The purpose of PG education is to create specialists who would provide high quality', 50, 100, 400),
        placed('health care and advance the cause of science through research & training.', 62, 160, 330),
      ]),
    ]);

    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]?.text).toMatch(/high quality health care/);
  });

  it('ends the paragraph on a short line with a full stop', () => {
    const paragraphs = pagesToParagraphs([
      page([
        placed('Pharmacology consists of both the experimental (basic) and clinical', 50, 100, 400),
        placed('sciences.', 50, 100 + LEADING, 78),
        placed('Experimental pharmacology is essential to understanding of drug action in diseases', 50, 100 + LEADING * 2, 400),
      ]),
    ]);

    expect(paragraphs.map((current) => current.text)).toEqual([
      'Pharmacology consists of both the experimental (basic) and clinical sciences.',
      'Experimental pharmacology is essential to understanding of drug action in diseases',
    ]);
  });

  it('keeps a heading out of the paragraph under it', () => {
    const paragraphs = pagesToParagraphs([
      page([
        placed('Preamble', 50, 100, 62),
        placed('The purpose of PG education is to create specialists who would provide high quality', 50, 121, 400),
        placed('health care and advance the cause of science through research & training.', 50, 141, 330),
      ]),
    ]);

    expect(paragraphs.map((current) => current.text)).toEqual([
      'Preamble',
      'The purpose of PG education is to create specialists who would provide high quality health care and advance the cause of science through research & training.',
    ]);
  });

  it('keeps a centred title in one block', () => {
    // Lines that do not share a left edge but do share a centre are a title, not
    // three indented paragraphs.
    const paragraphs = pagesToParagraphs([
      page([
        placed('GUIDELINES FOR COMPETENCY BASED', 120, 100, 360, 14),
        placed('POSTGRADUATE TRAINING PROGRAMME', 105, 100 + LEADING, 390, 14),
        placed('FOR MD IN PHARMACOLOGY', 140, 100 + LEADING * 2, 320, 14),
      ]),
    ]);

    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]?.text).toBe(
      'GUIDELINES FOR COMPETENCY BASED POSTGRADUATE TRAINING PROGRAMME FOR MD IN PHARMACOLOGY',
    );
  });

  it('starts a paragraph at a first-line indent', () => {
    const paragraphs = pagesToParagraphs([
      page([
        placed('Pharmacology consists of both the experimental (basic) and clinical sciences.', 50, 100, 400),
        placed('Experimental pharmacology is essential to understanding of drug action.', 64, 100 + LEADING, 400),
      ]),
    ]);

    expect(paragraphs.map((current) => current.text)).toEqual([
      'Pharmacology consists of both the experimental (basic) and clinical sciences.',
      'Experimental pharmacology is essential to understanding of drug action.',
    ]);
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
