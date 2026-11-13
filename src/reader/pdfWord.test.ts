import { describe, expect, it } from 'vitest';
import { wordRects } from './pdfWord';

const line = (y: number, w: number) => ({ page: 1, x: 10, y, w, h: 12 });

describe('wordRects', () => {
  it('places a word by its share of the sentence on one line', () => {
    // "aaaa bbbb" is 9 characters over 90 units: "bbbb" starts at 5.
    expect(wordRects([line(0, 90)], 'aaaa bbbb', 5)).toEqual([{ page: 1, x: 60, y: 0, w: 40, h: 12 }]);
  });

  it('finds the word on the second line of a wrapped sentence', () => {
    const [rect] = wordRects([line(0, 50), line(20, 50)], 'aaaa bbbb cc', 10);
    expect(rect.y).toBe(20);
    expect(rect.x).toBeGreaterThan(10);
  });

  it('gives nothing without rectangles or with an index past the text', () => {
    expect(wordRects([], 'abc', 0)).toEqual([]);
    expect(wordRects([line(0, 90)], 'abc', 9)).toEqual([]);
  });
});
