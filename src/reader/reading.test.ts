import { describe, expect, it } from 'vitest';
import type { Block, Chapter, Sentence } from '../core/types';
import { DEFAULT_SKIP, isSkipped, planChapter, skippedLabel, type BlockKind } from './reading';

function sentence(id: string, text: string): Sentence {
  return { id, text };
}

function block(id: string, kind: BlockKind, texts: string[]): Block {
  return { id, kind, sentences: texts.map((text, i) => sentence(`${id}-${i}`, text)) };
}

function chapter(blocks: Block[]): Chapter {
  return { id: 'ch-0', title: 'Kinetics', blocks };
}

const SKIP_NONE = {
  ...DEFAULT_SKIP,
  tables: false,
  figures: false,
  captions: false,
  formulas: false,
  headersFooters: false,
  footnotes: false,
  references: false,
  citations: false,
};

describe('planChapter', () => {
  it('reads every sentence of a plain chapter in order', () => {
    const plan = planChapter(chapter([block('b1', 'p', ['One.', 'Two.']), block('b2', 'h', ['Heading'])]), SKIP_NONE, 0);
    expect(plan.items.map((item) => item.id)).toEqual(['b1-0', 'b1-1', 'b2-0']);
    expect(plan.orderById.get('b2-0')).toBe(2);
    expect(plan.skippedBlocks.size).toBe(0);
  });

  it('leaves tables, figures, captions and formulas out of the voice', () => {
    const plan = planChapter(
      chapter([
        block('b1', 'p', ['Text.']),
        block('b2', 'table', ['Table 1. Outcomes by arm.']),
        block('b3', 'figure', ['Figure 2. Plasma curve.']),
        block('b4', 'caption', ['Caption.']),
        block('b5', 'formula', ['C = D / V']),
        block('b6', 'footnote', ['Funded by a grant.']),
        block('b7', 'reference', ['Smith J. 2019.']),
        block('b8', 'p', ['More text.']),
      ]),
      DEFAULT_SKIP,
      0,
    );
    expect(plan.items.map((item) => item.id)).toEqual(['b1-0', 'b8-0']);
    expect([...plan.skippedBlocks].sort()).toEqual(['b2', 'b3', 'b4', 'b5', 'b6', 'b7']);
    expect(plan.blockKinds.get('b3')).toBe('figure');
  });

  it('reads a skipped kind when its switch is off', () => {
    const plan = planChapter(chapter([block('b1', 'table', ['Data.'])]), { ...DEFAULT_SKIP, tables: false }, 0);
    expect(plan.items.map((item) => item.id)).toEqual(['b1-0']);
    expect(isSkipped('table', { ...DEFAULT_SKIP, tables: false })).toBe(false);
  });

  it('strips citations from the spoken text but keeps the displayed text', () => {
    const plan = planChapter(chapter([block('b1', 'p', ['It works [12].'])]), DEFAULT_SKIP, 0);
    const item = plan.items[0]!;
    expect(item.text).toBe('It works [12].');
    expect(item.spoken).toBe('It works.');
    expect(item.charMap?.[0]).toBe(0);
  });

  it('puts a paragraph pause after the last sentence of a block only', () => {
    const text = chapter([block('b1', 'p', ['One.', 'Two.']), block('b2', 'p', ['Three.'])]);
    const plan = planChapter(text, SKIP_NONE, 300);
    expect(plan.items.map((item) => item.pauseAfterMs)).toEqual([undefined, 300, 300]);
    expect(plan.endsBlock.has('b1-1')).toBe(true);
    expect(plan.endsBlock.has('b1-0')).toBe(false);
  });

  it('never pauses when the reader set the pause to zero', () => {
    const plan = planChapter(chapter([block('b1', 'p', ['One.', 'Two.'])]), SKIP_NONE, 0);
    expect(plan.items.every((item) => item.pauseAfterMs === undefined)).toBe(true);
  });

  it('labels what it left out', () => {
    expect(skippedLabel('table')).toBe('Table');
    expect(skippedLabel('figure')).toBe('Figure');
    expect(skippedLabel('header')).toBe('Running head');
    expect(skippedLabel('footnote')).toBe('Footnote');
  });
});
