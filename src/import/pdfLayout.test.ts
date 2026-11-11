import { describe, expect, it } from 'vitest';
import {
  chaptersFromPages,
  classifyParagraphs,
  dropPageFurniture,
  itemsToLines,
  itemsToPageLines,
  needsModelLayout,
  pagesToParagraphs,
  rectsForRange,
  stitchPages,
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

  it('keeps a sentence whole when it runs from the foot of one column to the head of the next', () => {
    const paragraphs = pagesToParagraphs([
      page([line('mutations in the filaggrin gene have been', 700), line('identified as the main factor.', 80)]),
    ]);

    expect(paragraphs.map((current) => current.text)).toEqual([
      'mutations in the filaggrin gene have been identified as the main factor.',
    ]);
  });

  it('keeps the space pdf.js reports between runs when the gap is too narrow to prove one', () => {
    // "studied" (roman), " in vivo" (italic), " induced" (roman): 1.7pt gaps at 9pt type.
    const row = [item('studied', 50, 100, 30, 9), item(' in vivo', 81.7, 100, 24, 9), item(' induced', 107.4, 100, 30, 9)];
    const [only] = pagesToParagraphs([page(itemsToLines(row))]);

    expect(only?.text).toBe('studied in vivo induced');
  });

  it('still closes a compound whose hyphen ends a run, space or not', () => {
    const row = [item('anti-', 50, 100, 20, 9), item(' JAK2 antibody', 71.7, 100, 60, 9)];
    const [only] = pagesToParagraphs([page(itemsToLines(row))]);

    expect(only?.text).toBe('anti-JAK2 antibody');
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

describe('needsModelLayout', () => {
  /** A page of plain prose: full-width lines, one pitch apart, no furniture. */
  const proseLines = (rows = 20): PdfLine[] =>
    Array.from({ length: rows }, (_, row) => line(`A line of ordinary body text number ${row}.`, 100 + row * 14));
  const prose = (rows = 20): PdfPage => page(proseLines(rows));

  it('leaves a page of prose to the text heuristics', () => {
    expect(needsModelLayout(prose())).toBe(false);
  });

  it('asks for the model when the page is a table or a form', () => {
    const rows = Array.from({ length: 4 }, (_, row) => {
      const y = 120 + row * 18;
      return {
        text: 'Sr. No. | Particulars | Not Satisfactory | Remarks',
        x: 60,
        y,
        w: 460,
        h: 12,
        items: [
          item(`${row + 1}.`, 60, y, 20),
          item('Particulars of the course', 120, y, 150),
          item('1 2 3', 300, y, 40),
          item('' + row, 480, y, 20),
        ],
      };
    });
    expect(needsModelLayout(page(rows))).toBe(true);
  });

  it('asks for the model when a figure is printed above the text', () => {
    const lines = proseLines(12).map((body) => ({ ...body, y: body.y + 200 }));
    expect(needsModelLayout(page(lines))).toBe(true);
  });

  it('does not call the model for a line that merely mentions a figure', () => {
    const lines = proseLines(12);
    lines[4] = line('Figure 3 shows the effect on the skin of the treated mice.', 156);
    expect(needsModelLayout(page(lines))).toBe(false);
  });

  it('asks for the model when a figure leaves a hole in the text', () => {
    const lines = [
      ...proseLines(5),
      line('The rest of the text resumes well below the figure.', 500),
      line('And a last line under it.', 514),
    ];
    expect(needsModelLayout(page(lines))).toBe(true);
  });
});

describe('stitchPages', () => {
  const kinded = (pageNumber: number, text: string, kind: PdfParagraph['kind']): PdfParagraph => ({
    ...paragraph(pageNumber, text),
    kind,
  });

  it('joins a sentence cut by a page break', () => {
    const out = stitchPages([paragraph(1, 'Thiazides act on the distal'), paragraph(2, 'convoluted tubule.')]);
    expect(out.map((part) => part.text)).toEqual(['Thiazides act on the distal convoluted tubule.']);
  });

  it('joins across the footer and the running head that sit between the two halves', () => {
    const out = stitchPages([
      paragraph(1, 'Thiazides act on the distal'),
      kinded(1, 'Downloaded from bpspubs on 12 May 2024', 'footer'),
      kinded(2, 'H-J An et al', 'header'),
      paragraph(2, 'convoluted tubule.'),
    ]);

    // The body sentence is whole and still body text; the furniture stays skippable
    // and is not glued onto the page that follows it.
    expect(out.map((part) => `${part.kind ?? 'p'}: ${part.text}`)).toEqual([
      'p: Thiazides act on the distal convoluted tubule.',
      'footer: Downloaded from bpspubs on 12 May 2024',
      'header: H-J An et al',
    ]);
  });

  it('never continues a caption or a table into the prose of the next page', () => {
    const out = stitchPages([
      paragraph(1, 'The dose was halved.'),
      kinded(1, 'Figure 2 Effects of melittin on filaggrin', 'caption'),
      paragraph(2, 'and the response was measured weekly.'),
    ]);

    expect(out.map((part) => part.kind ?? 'p')).toEqual(['p', 'caption', 'p']);
    expect(out[1].text).toBe('Figure 2 Effects of melittin on filaggrin');
  });
});

describe('classifyParagraphs', () => {
  it('marks a caption, and leaves a sentence that only opens with a figure number as prose', () => {
    const out = classifyParagraphs(
      [
        paragraph(1, 'Figure 3–1 illustrates a fundamental hypothesis of pharmacology.'),
        paragraph(1, 'FIGURE 3–1 The relationship between dose and effect.'),
        paragraph(1, 'Table 2. Doses used in the study.'),
        paragraph(1, 'Table 2 shows the doses used in the study.'),
      ],
      [],
    );

    expect(out.map((part) => part.kind ?? 'p')).toEqual(['p', 'caption', 'caption', 'p']);
  });
});
