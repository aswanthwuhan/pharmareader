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
});
