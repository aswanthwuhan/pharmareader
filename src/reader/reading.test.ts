import { describe, expect, it } from 'vitest';
import type { Block, Chapter, Sentence } from '../core/types';
import {
  DEFAULT_SKIP,
  isBracketMode,
  isSkipped,
  planChapter,
  planSelection,
  resolveBracketMode,
  skippedLabel,
  type BlockKind,
} from './reading';

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

  it('announces brackets with the default mode', () => {
    const plan = planChapter(chapter([block('b1', 'p', ['The system (ANS) acts.'])]), DEFAULT_SKIP, 0);
    expect(plan.items[0]?.text).toBe('The system (ANS) acts.');
    expect(plan.items[0]?.spoken).toBe('The system, ANS in brackets, acts.');
    expect(plan.items[0]?.charMap).not.toBeNull();
  });

  it('reads the brackets of a formula as written', () => {
    const plan = planChapter(
      chapter([block('b1', 'formula', ['Dose (mg) = D / V'])]),
      { ...DEFAULT_SKIP, formulas: false },
      0,
    );
    expect(plan.items[0]?.text).toBe('Dose (mg) = D / V');
    expect(plan.items[0]?.spoken).toBeUndefined();
  });

  it('drops brackets entirely in skip mode', () => {
    const plan = planChapter(
      chapter([block('b1', 'p', ['Give 2 mg (twice daily) now.'])]),
      { ...DEFAULT_SKIP, brackets: 'skip' },
      0,
    );
    expect(plan.items[0]?.spoken).toBe('Give 2 mg now.');
  });
});

describe('planSelection', () => {
  const text = chapter([
    block('b1', 'p', ['One.', 'Two.']),
    block('b2', 'table', ['Table 1. Outcomes.']),
    block('b3', 'p', ['Three (I think).']),
  ]);

  it('builds a queue in the order the sentences were selected', () => {
    const items = planSelection(text, ['b1-1', 'b1-0'], SKIP_NONE, 0);
    expect(items.map((item) => item.id)).toEqual(['b1-1', 'b1-0']);
  });

  it('keeps only one copy of a sentence selected twice', () => {
    const items = planSelection(text, ['b1-0', 'b1-0', 'b1-1'], SKIP_NONE, 0);
    expect(items.map((item) => item.id)).toEqual(['b1-0', 'b1-1']);
  });

  it('plays a sentence of a skipped kind when it was selected by hand', () => {
    const items = planSelection(text, ['b2-0'], DEFAULT_SKIP, 0);
    expect(items.map((item) => item.id)).toEqual(['b2-0']);
    expect(items[0]?.text).toBe('Table 1. Outcomes.');
  });

  it('plays a passage made only of skipped kinds', () => {
    const skippedOnly = chapter([
      block('s1', 'table', ['Table 1. Outcomes.']),
      block('s2', 'figure', ['Figure 1. Curve.']),
      block('s3', 'footnote', ['A footnote.']),
    ]);
    const items = planSelection(skippedOnly, ['s1-0', 's2-0', 's3-0'], DEFAULT_SKIP, 0);
    expect(items.map((item) => item.id)).toEqual(['s1-0', 's2-0', 's3-0']);
    expect(items.map((item) => item.text)).toEqual(['Table 1. Outcomes.', 'Figure 1. Curve.', 'A footnote.']);
  });

  it('ignores ids that are not in the chapter', () => {
    expect(planSelection(text, ['nope', 'b1-0'], SKIP_NONE, 0).map((item) => item.id)).toEqual(['b1-0']);
    expect(planSelection(text, [], SKIP_NONE, 0)).toEqual([]);
  });

  it('still strips citations and announces brackets', () => {
    const items = planSelection(text, ['b3-0'], DEFAULT_SKIP, 0);
    expect(items[0]?.spoken).toBe('Three, in brackets, I think, close bracket.');
  });

  it('keeps the block pause off selected sentences', () => {
    const items = planSelection(text, ['b1-0', 'b1-1'], SKIP_NONE, 300);
    expect(items.map((item) => item.pauseAfterMs)).toEqual([undefined, undefined]);
  });
});

describe('bracket setting', () => {
  it('accepts the three modes only', () => {
    expect(isBracketMode('announce')).toBe(true);
    expect(isBracketMode('read')).toBe(true);
    expect(isBracketMode('skip')).toBe(true);
    expect(isBracketMode('loud')).toBe(false);
    expect(isBracketMode(true)).toBe(false);
    expect(isBracketMode(undefined)).toBe(false);
  });

  it('migrates the old on/off switch to a mode', () => {
    expect(resolveBracketMode(undefined, true)).toBe('skip');
    expect(resolveBracketMode(undefined, false)).toBe('announce');
    expect(resolveBracketMode(undefined, undefined)).toBe('announce');
  });

  it('lets the stored mode win over the old switch', () => {
    expect(resolveBracketMode('read', true)).toBe('read');
    expect(resolveBracketMode('announce', true)).toBe('announce');
  });
});
