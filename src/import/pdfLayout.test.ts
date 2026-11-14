import { describe, expect, it } from 'vitest';
import {
  chaptersFromPages,
  classifyParagraphs,
  documentGutter,
  dropPageFurniture,
  itemsToLines,
  itemsToPageLines,
  needsModelLayout,
  pageGutter,
  pageRunsInColumns,
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
    // The column stops at the end of a sentence above a title, as a real one
    // does; its last line also overhangs the corridor without reaching across it.
    items[18] = item('left9 is over.', 40, 100 + 9 * 14, 320);
    items.push(item('A full width title', 40, 233, 520));

    const texts = itemsToPageLines(items, 600).map((current) => current.text);
    const title = texts.indexOf('A full width title');

    const band = (rows: number[]) => [
      ...rows.map((row) => (row === 9 ? 'left9 is over.' : `left${row}`)),
      ...rows.map((row) => `right${row}`),
    ];
    // Rows above the title: the whole left column, then the whole right one.
    expect(texts.slice(0, title)).toEqual(band([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(texts.slice(title + 1)).toEqual(band([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]));
  });

  it('keeps the short last line of a full-width block whole', () => {
    const items = twoColumns(10);
    // A caption block below the columns: two lines reach the right margin, the
    // last one stops short of the right column's body (bjp-bee-venom p12). No
    // left column runs above it, so it cannot be a column line overhanging.
    items.push(
      item('Figure 7', 42, 300, 42),
      item('a caption line that fills the width', 42, 324, 510),
      item('the caption tail', 42, 348, 280),
      item(' ends here.', 320, 348, 50),
    );

    const texts = itemsToPageLines(items, 600).map((current) => current.text);

    expect(texts).toContain('the caption tail ends here.');
    expect(texts).not.toContain('the caption tail');
  });

  it('reads a table row by row, not its left cells then its right ones', () => {
    // A full-page table: every row starts a cell at each of these five edges, so
    // the page has five columns of cells rather than two columns of text. The
    // widest space between cells is a real corridor with a wide cell on each side
    // of it, so the page is otherwise read as two columns. Split there and every
    // row reads as its left cells and then its right ones, with the header cells
    // reordered with them; a table is read row by row, as it is printed.
    const items: PdfTextItem[] = [];
    for (let row = 0; row < 20; row++) {
      for (let column = 0; column < 5; column++) {
        items.push(item(`r${row}c${column}`, 40 + column * 122, 100 + row * 14, 110));
      }
    }

    const texts = itemsToPageLines(items, 700).map((current) => current.text);

    expect(texts[0]).toBe('r0c0 r0c1 r0c2 r0c3 r0c4');
    expect(texts[19]).toBe('r19c0 r19c1 r19c2 r19c3 r19c4');
  });

  it('still reads a two-column page whose paragraphs start at two indents', () => {
    // Only two edges carry most rows here, so the page is text in two columns and
    // an indented first line must not pass for a table's extra column.
    const items: PdfTextItem[] = [];
    for (let row = 0; row < 20; row++) {
      items.push(item(`left${row}`, row % 3 === 0 ? 56 : 40, 100 + row * 14, 240), item(`right${row}`, 320, 100 + row * 14, 240));
    }

    const texts = itemsToPageLines(items, 600).map((current) => current.text);

    expect(texts.slice(0, 20)).toEqual(Array.from({ length: 20 }, (_, row) => `left${row}`));
    expect(texts.slice(20)).toEqual(Array.from({ length: 20 }, (_, row) => `right${row}`));
  });

  it('finds no corridor between a list marker and the line it marks', () => {
    // A one-column page of bulleted paragraphs: the markers sit 12 pt left of the
    // text, and that gap is not a column gutter. Taken for one, the page reads
    // every bullet first and then all of its lines (the NMC guidelines do this).
    const items: PdfTextItem[] = [];
    for (let row = 0; row < 20; row++) {
      items.push(item('\u2022', 144, 100 + row * 18, 6), item(`bulleted line ${row}`, 162, 100 + row * 18, 320));
    }

    expect(pageGutter(items, 600)).toBeNull();
    const texts = itemsToPageLines(items, 600).map((current) => current.text);
    expect(texts[0]).toBe('\u2022 bulleted line 0');
    expect(texts[19]).toBe('\u2022 bulleted line 19');
  });

  it('reads a list line whose text starts right of the corridor in one line', () => {
    // A one-column list: the number is its own item and the text begins just
    // right of the corridor the page shows between them. One item crosses that
    // corridor, so the row is a line, not two column halves.
    const items: PdfTextItem[] = [];
    for (let row = 0; row < 20; row++) {
      items.push(item(`left column ${row}`, 90, 100 + row * 14, 190), item(`right ${row}`, 330, 100 + row * 14, 230));
    }
    items.push(item('12.', 90, 60, 15), item('Clinical pharmacology', 126, 60, 110));

    const texts = itemsToPageLines(items, 600).map((current) => current.text);

    expect(texts).toContain('12. Clinical pharmacology');
    expect(texts).not.toContain('12.');
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

  it('reads a boxed panel in bands of its own', () => {
    const items: PdfTextItem[] = [];
    const band = (label: string, y: number) => {
      for (let row = 0; row < 4; row++) {
        items.push(item(`${label} left ${row}`, 40, y + row * 14, 240));
        items.push(item(`${label} right ${row}`, 320, y + row * 14, 240));
      }
    };
    band('above', 100);
    band('panel', 165);
    band('below', 270);

    const texts = itemsToPageLines(items, 600, { panels: [{ x: 40, y: 150, w: 520, h: 110 }] }).map(
      (current) => current.text,
    );
    // Without the panel the left column runs from the top of the page to the
    // bottom, mixing the panel's two halves into the page's two columns.
    expect(itemsToPageLines(items, 600).map((current) => current.text).slice(0, 5)).toEqual([
      'above left 0',
      'above left 1',
      'above left 2',
      'above left 3',
      'panel left 0',
    ]);

    expect(texts.slice(0, 8)).toEqual([
      'above left 0',
      'above left 1',
      'above left 2',
      'above left 3',
      'above right 0',
      'above right 1',
      'above right 2',
      'above right 3',
    ]);
    expect(texts.slice(8, 12)).toEqual(['panel left 0', 'panel left 1', 'panel left 2', 'panel left 3']);
    expect(texts.slice(12, 16)).toEqual(['panel right 0', 'panel right 1', 'panel right 2', 'panel right 3']);
    expect(texts.slice(16)[0]).toBe('below left 0');
  });

  it('keeps a line that only overhangs the gutter inside its column', () => {
    const items: PdfTextItem[] = [];
    for (let row = 0; row < 20; row++) {
      items.push(item(`left ${row}`, 40, 100 + row * 20, 240), item(`right ${row}`, 320, 100 + row * 20, 240));
    }
    // A justified line whose last word runs 20 pt past the corridor: a quarter
    // into the right column would be needed for it to be a full-width line.
    items.push(item('left overhang', 40, 110, 300));

    const texts = itemsToPageLines(items, 600).map((current) => current.text);
    expect(texts.indexOf('left overhang')).toBe(1);
    expect(texts.indexOf('left 19')).toBeLessThan(texts.indexOf('right 0'));
  });

  it('reads a continuing sentence down its own column past a wide line', () => {
    const items: PdfTextItem[] = [];
    for (let row = 0; row < 16; row++) {
      items.push(item(`left ${row}`, 40, 100 + row * 20, 240), item(`right ${row}`, 320, 100 + row * 20, 240));
    }
    // The left column stops mid-sentence above the wide line and resumes with a
    // lower-case word under it: the line is the tail of that sentence.
    items[14] = item('metabolism for most drugs', 40, 240, 240);
    items[16] = item('hepatic clearance also depends', 40, 260, 240);
    items.push(item('the wide line that only just crosses', 40, 250, 520));

    const texts = itemsToPageLines(items, 600).map((current) => current.text);
    // The left column runs on: the sentence under the wide line is still read
    // before anything in the right column.
    expect(texts.indexOf('hepatic clearance also depends')).toBe(8);
    expect(texts.indexOf('hepatic clearance also depends')).toBeLessThan(texts.indexOf('right 0'));

    // End the sentence above the wide line and the same row is a band again.
    items[14] = item('metabolism for most drugs.', 40, 240, 240);
    const ended = itemsToPageLines(items, 600).map((current) => current.text);
    expect(ended.indexOf('right 0')).toBe(8);
    expect(ended.indexOf('metabolism for most drugs.')).toBe(7);
  });

  it('leaves a two-column page in row order when the caller says one column', () => {
    const texts = itemsToPageLines(twoColumns(4), 600, { columns: 1 }).map((current) => current.text);

    expect(texts).toEqual(['left0 right0', 'left1 right1', 'left2 right2', 'left3 right3']);
  });

  it('splits in the middle when the caller says two columns and no corridor shows', () => {
    // Four rows: too few for the page to show a corridor of its own.
    const texts = itemsToPageLines(twoColumns(4), 600, { columns: 2 }).map((current) => current.text);

    expect(texts).toEqual(['left0', 'left1', 'left2', 'left3', 'right0', 'right1', 'right2', 'right3']);
  });

  it('keeps a row whose last run starts right of the corridor in one line', () => {
    // A list line on a page whose corridor sits left of centre: the number and
    // first words are separate items, and the long run begins right of the
    // corridor's middle. No single item crosses it, but the row does.
    const items = [
      item('9.', 90, 71, 9),
      item(' Perform', 126, 71, 40),
      item(' in vivo', 168, 71, 33),
      item(' experiments to study the effect', 204, 71, 311),
      item('10. Continue', 90, 85, 120),
    ];

    const texts = itemsToPageLines(items, 612, { gutter: { start: 161, end: 180 } }).map(
      (current) => current.text,
    );

    expect(texts).toEqual(['9. Perform in vivo experiments to study the effect', '10. Continue']);
  });

  it('tells a two-column page from a one-column page abutting the same corridor', () => {
    const oneColumn = Array.from({ length: 10 }, (_, row) => item(`full width line ${row}`, 42, 100 + row * 20, 520));
    const gutter = { start: 280, end: 310 };

    // Full-width lines touch both sides of the corridor, so abutting text alone
    // cannot say the page reads in its columns.
    expect(pageRunsInColumns(oneColumn, gutter)).toBe(false);
    expect(pageRunsInColumns(twoColumns(10), gutter)).toBe(true);
    // A minority of full-width titles does not stop a two-column page.
    expect(pageRunsInColumns([...twoColumns(10), item('A full width title', 40, 60, 520)], gutter)).toBe(true);
  });

  it('splits at the corridor it is given, not the one it would find', () => {
    // The corridor sits left of every column edge, so every item belongs to the
    // right column and the page reads in row order: true only when the given one
    // is the corridor that was used.
    const texts = itemsToPageLines(twoColumns(4), 600, { gutter: { start: 20, end: 40 } }).map(
      (current) => current.text,
    );

    expect(texts).toEqual(['left0 right0', 'left1 right1', 'left2 right2', 'left3 right3']);
  });
});

describe('pageGutter', () => {
  const columns = (rows: number): PdfTextItem[] =>
    Array.from({ length: rows }, (_, row) => [
      item(`left ${row}`, 40, 100 + row * 20, 240),
      item(`right ${row}`, 320, 100 + row * 20, 240),
    ]).flat();

  it('finds the corridor between two columns', () => {
    const gutter = pageGutter(columns(20), 600);

    expect(gutter).not.toBeNull();
    expect(gutter!.start).toBeGreaterThan(260);
    expect(gutter!.end).toBeLessThan(340);
  });

  it('finds nothing on a page whose text sits on one side', () => {
    // A figure's white space leaves one empty run, but no text fills the other
    // column: a corridor needs text on both sides of it.
    const items = Array.from({ length: 20 }, (_, row) => item(`left ${row}`, 40, 100 + row * 20, 240));

    expect(pageGutter(items, 600)).toBeNull();
  });
});

describe('documentGutter', () => {
  const corridor = (start: number, end: number) => ({ start, end });

  it('takes the middle of the corridors the pages showed', () => {
    expect(documentGutter([corridor(280, 320), corridor(282, 318), corridor(290, 310), null, null], 5)).toEqual({
      start: 282,
      end: 318,
    });
  });

  it('stays out of it when only a few pages showed a corridor', () => {
    expect(documentGutter([corridor(280, 320), corridor(282, 318), null, null, null], 10)).toBeNull();
  });

  it('trusts two pages of three', () => {
    expect(documentGutter([corridor(280, 320), corridor(282, 318), null], 3)).not.toBeNull();
  });

  it('returns nothing when no page showed one', () => {
    expect(documentGutter([null, null], 2)).toBeNull();
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

  it('gives a sentence only its share of a text item that holds two sentences', () => {
    // One PDF item for the whole printed line, as pdf.js usually reports it.
    const line: PdfParagraph = {
      page: 1,
      text: 'aaaa bbbb.',
      spans: [{ start: 0, end: 10, item: item('aaaa bbbb.', 10, 100, 90) }],
    };
    const [second] = rectsForRange(line, 5, 10);
    expect(second!.x).toBeGreaterThan(50);
    expect(second!.x + second!.w).toBeCloseTo(100);
    const [first] = rectsForRange(line, 0, 4);
    expect(first!.x).toBe(10);
    expect(first!.x + first!.w).toBeLessThan(second!.x);
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
