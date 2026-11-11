import { describe, expect, it } from 'vitest';
import type { PdfTextItem } from '../pdfLayout';
import { layoutParagraphs, orderRegions, usableRegions } from './assign';
import type { LayoutBox } from './engine';

/** A run of words on one line, `count` items wide. */
function items(words: string[], x: number, y: number, step = 42): PdfTextItem[] {
  return words.map((word, index) => ({ str: word, x: x + index * step, y, w: step - 6, h: 10, page: 1 }));
}

function box(label: string, x: number, y: number, w: number, h: number, score = 0.9): LayoutBox {
  return { x, y, w, h, label, score };
}

describe('usableRegions', () => {
  it('drops labels it cannot read and keeps furniture however small', () => {
    const boxes = [
      box('table', 20, 20, 200, 100),
      box('inline_formula', 30, 30, 8, 6), // hairline noise inside the text
      box('number', 300, 780, 12, 10), // a page number is tiny on purpose
    ];

    const kept = usableRegions(boxes, 400, 800).map((region) => region.label);
    expect(kept).toEqual(['table', 'number']);
  });
});

describe('usableRegions (small text regions)', () => {
  it('keeps a one-line heading: only pictures and formulas can be too small to be a region', () => {
    const boxes = [
      box('paragraph_title', 60, 200, 120, 12), // "Pharmacokinetics": 0.2% of the page
      box('text', 60, 230, 150, 11), // a one-line paragraph
      box('formula', 200, 400, 14, 8), // an inline symbol inside a sentence
    ];

    expect(usableRegions(boxes, 600, 800).map((region) => region.label)).toEqual(['paragraph_title', 'text']);
  });
});

describe('orderRegions', () => {
  it('reads the left column before the right, and the header before both', () => {
    const boxes = [
      box('text', 210, 100, 180, 300),
      box('text', 20, 100, 180, 300),
      box('header', 20, 8, 370, 12),
      box('footer', 20, 780, 370, 12),
    ];

    expect(orderRegions(boxes, 400).map((region) => `${region.label}:${region.x}`)).toEqual([
      'header:20',
      'text:20',
      'text:210',
      'footer:20',
    ]);
  });

  it('reads a single column with wide margins top to bottom, centred title and short lines included', () => {
    // The body is 65% of the page wide, so nothing spans "the page"; it spans the text.
    const boxes = [
      box('text', 105, 300, 390, 80),
      box('text', 105, 150, 120, 12), // a short line, left-aligned
      box('paragraph_title', 220, 100, 160, 14), // centred over the column
      box('text', 105, 180, 390, 100),
      box('text', 105, 400, 100, 12),
    ];

    expect(orderRegions(boxes, 600).map((region) => region.y)).toEqual([100, 150, 180, 300, 400]);
  });

  it('lets a full-width title split the page into bands', () => {
    const boxes = [
      box('text', 210, 300, 180, 300), // right column, below the title
      box('text', 20, 300, 180, 300),
      box('paragraph_title', 20, 150, 370, 20), // spans the page
      box('text', 210, 20, 180, 100), // right column, above the title
      box('text', 20, 20, 180, 100),
    ];

    expect(orderRegions(boxes, 400).map((region) => `${region.label}:${region.x}:${region.y}`)).toEqual([
      'text:20:20',
      'text:210:20',
      'paragraph_title:20:150',
      'text:20:300',
      'text:210:300',
    ]);
  });

  it('reads a two-column page whose paragraphs happen to line up row by row, left column first', () => {
    // Both columns have three blocks of near-identical height and start at the
    // same height, so every right box is "on the same row" as a box beside it.
    // That must not turn two columns into one column of rows.
    const boxes = [
      box('text', 50, 100, 240, 180),
      box('text', 310, 100, 240, 160),
      box('text', 50, 300, 240, 120),
      box('text', 310, 280, 240, 120),
      box('text', 50, 440, 240, 260),
      box('text', 310, 420, 240, 260),
    ];

    expect(orderRegions(boxes, 600).map((region) => `${region.x}:${region.y}`)).toEqual([
      '50:100',
      '50:300',
      '50:440',
      '310:100',
      '310:280',
      '310:420',
    ]);
  });

  it('reads two columns of two paragraphs each column by column, even when they start and end together', () => {
    // Fewer than three blocks a column, tops and bottoms within a few lines of
    // each other: still stacked paragraphs, never rows of a form.
    const boxes = [
      box('text', 310, 100, 240, 280),
      box('text', 50, 100, 240, 300),
      box('text', 310, 400, 240, 300),
      box('text', 50, 420, 240, 280),
    ];

    expect(orderRegions(boxes, 600).map((region) => `${region.x}:${region.y}`)).toEqual([
      '50:100',
      '50:420',
      '310:100',
      '310:400',
    ]);
  });

  it('reads two columns across a wide gutter, with a centred title above them first', () => {
    const boxes = [
      box('text', 360, 150, 200, 500),
      box('text', 40, 150, 200, 250),
      box('text', 40, 420, 200, 230),
      box('paragraph_title', 200, 100, 200, 16), // centred, narrower than 70% of the text
    ];

    expect(orderRegions(boxes, 600).map((region) => `${region.x}:${region.y}`)).toEqual([
      '200:100',
      '40:150',
      '40:420',
      '360:150',
    ]);
  });

  it('reads three columns left to right, each to its foot', () => {
    const boxes = [
      box('text', 410, 100, 170, 300),
      box('text', 220, 100, 170, 290),
      box('text', 30, 100, 170, 310),
      box('text', 30, 430, 170, 250),
      box('text', 220, 410, 170, 270),
      box('text', 410, 420, 170, 260),
    ];

    expect(orderRegions(boxes, 600).map((region) => `${region.x}:${region.y}`)).toEqual([
      '30:100',
      '30:430',
      '220:100',
      '220:410',
      '410:100',
      '410:420',
    ]);
  });

  it('keeps a form value on the line of the field it fills, one field after another', () => {
    // The right-hand column of a form is single lines, each on a row with its
    // label: nothing there is stacked, so it is not a column of its own.
    const boxes = [
      box('text', 20, 100, 80, 10),
      box('text', 200, 100, 120, 10),
      box('text', 20, 300, 80, 10),
      box('text', 200, 300, 120, 10),
      box('text', 20, 500, 80, 10),
      box('text', 200, 500, 120, 10),
    ];

    expect(orderRegions(boxes, 600).map((region) => `${region.x}:${region.y}`)).toEqual([
      '20:100',
      '200:100',
      '20:300',
      '200:300',
      '20:500',
      '200:500',
    ]);
  });
});

describe('layoutParagraphs', () => {
  it('rebuilds paragraphs from the regions that contain them, in reading order', () => {
    const page = { width: 400, height: 800 };
    const items_: PdfTextItem[] = [
      ...items(['left', 'one'], 20, 100),
      ...items(['left', 'two'], 20, 120),
      ...items(['right', 'one'], 210, 100),
    ];
    const boxes = [box('text', 210, 90, 180, 60), box('text', 20, 90, 180, 60)];

    const paragraphs = layoutParagraphs(1, page.width, page.height, items_, boxes, { pitch: 20, measure: 180 });

    expect(paragraphs.map((paragraph) => paragraph.text)).toEqual(['left one left two', 'right one']);
    expect(paragraphs.every((paragraph) => paragraph.kind === 'p')).toBe(true);
  });

  it('keeps a table as a single block so its cells are not read as sentences', () => {
    const page = { width: 400, height: 800 };
    const items_: PdfTextItem[] = [
      // Three rows, three columns: a grid the model recognised as one table.
      ...['1', '10', '20'].flatMap((cell, index) => items([cell], 30 + index * 120, 200)),
      ...['2', '11', '21'].flatMap((cell, index) => items([cell], 30 + index * 120, 220)),
      ...['3', '12', '22'].flatMap((cell, index) => items([cell], 30 + index * 120, 240)),
    ];
    const boxes = [box('table', 20, 190, 360, 70)];

    const paragraphs = layoutParagraphs(1, page.width, page.height, items_, boxes, { pitch: 20, measure: 360 });

    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0].kind).toBe('table');
    expect(paragraphs[0].text).toBe('1 10 20 2 11 21 3 12 22');
  });

  it('keeps a paragraph the model boxed in with a picture, and still skips the labels of a diagram', () => {
    const page = { width: 400, height: 800 };
    const words = 'the clinician must determine the dose that most closely achieves this goal'.split(' ');
    // Four full lines of running text, then two short labels of a diagram, all inside one image box.
    const prose = [0, 1, 2, 3].flatMap((row) => items(words.slice(0, 8), 20, 100 + row * 20));
    const labels = [...items(['Input'], 150, 300), ...items(['Elimination'], 150, 360)];
    const boxes = [box('image', 10, 90, 380, 300)];

    const paragraphs = layoutParagraphs(1, page.width, page.height, [...prose, ...labels], boxes, { pitch: 20, measure: 360 });

    expect(paragraphs.filter((paragraph) => paragraph.kind === 'p')).toHaveLength(1);
    expect(paragraphs.filter((paragraph) => paragraph.kind === 'p')[0].text).toContain('the clinician must determine');
    expect(paragraphs.filter((paragraph) => paragraph.kind === 'figure').map((paragraph) => paragraph.text)).toEqual([
      'Input',
      'Elimination',
    ]);
  });

  it('does not take a chart legend for prose on a page whose only text is a narrow caption', () => {
    const page = { width: 400, height: 800 };
    const words = 'placebo low dose medium dose high dose'.split(' ');
    // Six legend lines, 150 pt wide: wider than the 100 pt caption measure, under half the sheet.
    const legend = [0, 1, 2, 3, 4, 5].flatMap((row) => items(words.slice(0, 4), 40, 100 + row * 20, 38));
    const boxes = [box('chart', 10, 90, 380, 300)];

    const paragraphs = layoutParagraphs(1, page.width, page.height, legend, boxes, { pitch: 20, measure: 100 });

    expect(paragraphs.every((paragraph) => paragraph.kind === 'figure')).toBe(true);
  });

  it('labels a caption region as a caption', () => {
    const page = { width: 400, height: 800 };
    const items_ = items(['Fig.', '2', 'Effect', 'of', 'venom'], 20, 300);
    const boxes = [box('figure_title', 18, 292, 360, 20)];

    const paragraphs = layoutParagraphs(1, page.width, page.height, items_, boxes, { pitch: 20, measure: 360 });
    expect(paragraphs.map((paragraph) => paragraph.kind)).toEqual(['caption']);
  });

  it('keeps text that the model put in no region', () => {
    const page = { width: 400, height: 800 };
    const items_ = [...items(['body', 'text'], 20, 100), ...items(['stray', 'note'], 20, 600)];
    const boxes = [box('text', 18, 92, 360, 24)];

    const paragraphs = layoutParagraphs(1, page.width, page.height, items_, boxes, { pitch: 20, measure: 360 });
    expect(paragraphs.map((paragraph) => paragraph.text)).toEqual(['body text', 'stray note']);
  });

  it('reads text the model missed where it sits on the page, not after everything else', () => {
    const page = { width: 400, height: 800 };
    const items_ = [
      ...items(['first', 'paragraph'], 20, 100),
      ...items(['missed', 'paragraph'], 20, 300), // no box: the model scored it under the threshold
      ...items(['last', 'paragraph'], 20, 500),
      ...items(['12'], 190, 770),
    ];
    const boxes = [box('text', 18, 92, 360, 24), box('text', 18, 492, 360, 24), box('number', 186, 766, 30, 16)];

    const paragraphs = layoutParagraphs(1, page.width, page.height, items_, boxes, { pitch: 20, measure: 360 });
    expect(paragraphs.map((paragraph) => `${paragraph.kind}:${paragraph.text}`)).toEqual([
      'p:first paragraph',
      'p:missed paragraph',
      'p:last paragraph',
      'footer:12',
    ]);
  });
});
