import { describe, expect, it } from 'vitest';
import { wordRects } from './pdfWord';

const line = (y: number, w: number) => ({ page: 1, x: 10, y, w, h: 12 });

describe('wordRects', () => {
  it('places a word by its share of the line', () => {
    // "aaaa bbbb": two words of 2 em and a 0.25 em space over 85 units, 20 per em.
    expect(wordRects([line(0, 85)], 'aaaa bbbb', 5)).toEqual([{ page: 1, x: 55, y: 0, w: 40, h: 12 }]);
  });

  it('finds the word on the second line of a wrapped sentence', () => {
    const [rect] = wordRects([line(0, 50), line(20, 50)], 'aaaa bbbb cc', 10);
    expect(rect.y).toBe(20);
    expect(rect.x).toBeGreaterThan(10);
  });

  it('starts each line at its own left edge and ends it at its right edge', () => {
    const rects = [line(0, 70), line(20, 110)];
    const text = 'illicit illicit illicit common common common';
    const first = (word: number) => wordRects(rects, text, text.split(' ').slice(0, word).join(' ').length + (word ? 1 : 0))[0]!;
    // Narrow words on the first line, wide ones on the second: equal character
    // widths would put the break in the middle of a word.
    expect(first(0)).toMatchObject({ y: 0, x: 10 });
    expect(first(2).y).toBe(0);
    expect(first(2).x + first(2).w).toBeCloseTo(80);
    expect(first(3)).toMatchObject({ y: 20, x: 10 });
    expect(first(5).x + first(5).w).toBeCloseTo(120);
  });

  it('gives a narrow word less room than a wide one', () => {
    const text = 'ill mmm';
    const narrow = wordRects([line(0, 90)], text, 0)[0]!;
    const wide = wordRects([line(0, 90)], text, 4)[0]!;
    expect(narrow.w).toBeLessThan(wide.w / 2);
  });

  it('gives nothing without rectangles or with an index past the text', () => {
    expect(wordRects([], 'abc', 0)).toEqual([]);
    expect(wordRects([line(0, 90)], 'abc', 9)).toEqual([]);
  });
});
