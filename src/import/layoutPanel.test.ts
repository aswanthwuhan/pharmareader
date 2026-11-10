import { describe, expect, it } from 'vitest';
import type { ReanalyseResult } from './index';
import { describeRun } from './LayoutModelPanel';

/** A run where nothing went wrong, so each test only states what it is about. */
function totals(overrides: Partial<ReanalyseResult> = {}): ReanalyseResult {
  return {
    layout: 'heuristic',
    modelPages: 0,
    sentencesBefore: 100,
    sentencesAfter: 100,
    highlightsKept: 0,
    highlightsUnlinked: 0,
    bookmarksKept: 0,
    bookmarksMoved: 0,
    positionKept: true,
    ...overrides,
  };
}

describe('describeRun', () => {
  it('does not claim the model was unused when it laid out pages before stopping', () => {
    // A page that cannot be rasterised disposes the detector; `pdf.ts` then records
    // the book as `heuristic` although the model did layout `modelPages` pages.
    const summary = describeRun(2, 0, 0, totals({ modelPages: 7 }));

    expect(summary).not.toContain('the model was not used');
    expect(summary).toContain('7 pages');
    expect(summary).toContain('stopped');
  });

  it('says the model was not used only when no page was laid out', () => {
    expect(describeRun(1, 0, 0, totals({ modelPages: 0 }))).toContain('the model was not used');
  });

  it('names the books the model ran on and the pages it laid out', () => {
    const summary = describeRun(3, 2, 0, totals({ modelPages: 30 }));

    expect(summary).toContain('with the model on 2');
    expect(summary).toContain('30 pages');
  });

  it('describes kept, unlinked and moved reading marks without saying anything was dropped', () => {
    const summary = describeRun(
      1,
      0,
      0,
      totals({ highlightsKept: 3, highlightsUnlinked: 2, bookmarksMoved: 1, positionKept: false }),
    );

    expect(summary).toContain('3 highlights carried across');
    expect(summary).toContain('2 could not be found again and are kept in your notes without a place in the text');
    expect(summary).toContain('1 bookmark moved to the nearest text that is still there');
    expect(summary).toContain('a reading position was moved');
    expect(summary).not.toMatch(/deleted|dropped|removed/);
  });

  it('counts out a book that could not be read', () => {
    expect(describeRun(3, 0, 1, totals())).toContain('Re-analysed 2 of 3 PDFs');
    expect(describeRun(3, 0, 1, totals())).toContain('1 could not be read');
  });
});
