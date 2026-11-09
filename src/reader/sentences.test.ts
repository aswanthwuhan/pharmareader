import { describe, expect, it } from 'vitest';
import type { Highlight, ParsedDoc } from '../core/types';
import { highlightBySentence, indexBook, posForSaved, sentenceAt, stepPos, windowRange } from './sentences';

const doc: ParsedDoc = {
  title: 'Doc',
  format: 'txt',
  chapters: [
    {
      id: 'ch-0',
      title: 'One',
      blocks: [
        { id: 'b-0-0', kind: 'p', sentences: [{ id: '0-0-0', text: 'a' }, { id: '0-0-1', text: 'b' }] },
        { id: 'b-0-1', kind: 'p', sentences: [{ id: '0-1-0', text: 'c' }] },
      ],
    },
    { id: 'ch-1', title: 'Two', blocks: [{ id: 'b-1-0', kind: 'p', sentences: [{ id: '1-0-0', text: 'd' }] }] },
  ],
};

describe('indexBook', () => {
  it('flattens blocks into reading order and numbers positions per chapter', () => {
    const index = indexBook(doc);
    expect(index.chapters[0]?.map((s) => s.id)).toEqual(['0-0-0', '0-0-1', '0-1-0']);
    expect(index.chapters[0]?.[2]?.index).toBe(2);
    expect(index.chapters[1]?.[0]?.chapterIndex).toBe(1);
  });

  it('maps every sentence id to its position', () => {
    const index = indexBook(doc);
    expect(index.byId.get('0-1-0')).toEqual({ chapterIndex: 0, index: 2 });
    expect(index.byId.get('1-0-0')).toEqual({ chapterIndex: 1, index: 0 });
  });

  it('returns the sentence at a position, or null outside the document', () => {
    const index = indexBook(doc);
    expect(sentenceAt(index, { chapterIndex: 1, index: 0 })?.text).toBe('d');
    expect(sentenceAt(index, { chapterIndex: 5, index: 0 })).toBeNull();
    expect(sentenceAt(index, null)).toBeNull();
  });
});

describe('posForSaved', () => {
  it('finds the exact sentence that was saved', () => {
    const index = indexBook(doc);
    expect(posForSaved(doc, index, { chapterId: 'ch-1', sentenceId: '1-0-0' })).toEqual({ chapterIndex: 1, index: 0 });
  });

  it('falls back to the saved chapter when the sentence is gone', () => {
    const index = indexBook(doc);
    expect(posForSaved(doc, index, { chapterId: 'ch-1', sentenceId: 'gone' })).toEqual({ chapterIndex: 1, index: 0 });
  });

  it('starts at the beginning when nothing matches', () => {
    const index = indexBook(doc);
    expect(posForSaved(doc, index, { chapterId: 'gone', sentenceId: 'gone' })).toEqual({ chapterIndex: 0, index: 0 });
    expect(posForSaved(doc, index)).toEqual({ chapterIndex: 0, index: 0 });
  });
});

describe('stepPos', () => {
  it('moves inside a chapter', () => {
    const index = indexBook(doc);
    expect(stepPos(index, { chapterIndex: 0, index: 0 }, 1)).toEqual({ chapterIndex: 0, index: 1 });
  });

  it('crosses into the next chapter and stops at the last sentence', () => {
    const index = indexBook(doc);
    expect(stepPos(index, { chapterIndex: 0, index: 2 }, 1)).toEqual({ chapterIndex: 1, index: 0 });
    expect(stepPos(index, { chapterIndex: 1, index: 0 }, 1)).toBeNull();
    expect(stepPos(index, { chapterIndex: 0, index: 0 }, -1)).toBeNull();
  });

  it('crosses back into the previous chapter', () => {
    const index = indexBook(doc);
    expect(stepPos(index, { chapterIndex: 1, index: 0 }, -1)).toEqual({ chapterIndex: 0, index: 2 });
  });
});

describe('windowRange', () => {
  it('renders everything when the chapter is short', () => {
    expect(windowRange(50, 20, 200)).toEqual({ start: 0, end: 50 });
    expect(windowRange(401, 0, 200)).toEqual({ start: 0, end: 401 });
  });

  it('renders a window around the cursor, with a full size at the edges', () => {
    expect(windowRange(2000, 1000, 200)).toEqual({ start: 800, end: 1201 });
    expect(windowRange(2000, 0, 200)).toEqual({ start: 0, end: 401 });
    expect(windowRange(2000, 1999, 200)).toEqual({ start: 1599, end: 2000 });
  });

  it('does not run past the paragraph list it is given', () => {
    expect(windowRange(0, 0, 200)).toEqual({ start: 0, end: 0 });
    expect(windowRange(500, null, 200)).toEqual({ start: 0, end: 401 });
    expect(windowRange(500, 9999, 200)).toEqual({ start: 99, end: 500 });
  });
});

describe('highlightBySentence', () => {
  const make = (id: string, sentenceIds: string[]): Highlight => ({
    id,
    bookId: 'b',
    sentenceIds,
    text: 't',
    color: 'yellow',
    topicIds: [],
    createdAt: 1,
  });

  it('keeps the newest highlight for a shared sentence', () => {
    const map = highlightBySentence([make('new', ['a', 'b']), make('old', ['b', 'c'])]);
    expect(map.get('b')?.id).toBe('new');
    expect(map.get('c')?.id).toBe('old');
  });
});
