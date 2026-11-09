/**
 * Turning a chapter into a playback queue.
 *
 * What is spoken is not always what is on screen: tables, figures, captions,
 * formulas, running heads and references can be skipped, citations and asides
 * can be cut out of the voice while staying in the text. The queue is derived
 * here so the reader can render the chapter entirely (skipped blocks dimmed)
 * while the player only ever sees the sentences it should say.
 */
import { useMemo } from 'react';
import type { Block, Chapter } from '../core/types';
import { useSetting } from '../core/settings';
import type { PlayerItem } from '../tts/player';
import { speakPlan } from './spoken';

/** The kinds a parsed block can carry ('p' | 'h' | 'li' | 'table' | …). */
export type BlockKind = Block['kind'];

export interface SkipOptions {
  tables: boolean;
  figures: boolean;
  captions: boolean;
  formulas: boolean;
  headersFooters: boolean;
  footnotes: boolean;
  references: boolean;
  citations: boolean;
  brackets: boolean;
}

export const DEFAULT_SKIP: SkipOptions = {
  tables: true,
  figures: true,
  captions: true,
  formulas: true,
  headersFooters: true,
  footnotes: true,
  references: true,
  citations: true,
  brackets: false,
};

/** Kinds that are read only when their switch is on. */
const OPTIONAL: Partial<Record<BlockKind, keyof SkipOptions>> = {
  table: 'tables',
  figure: 'figures',
  caption: 'captions',
  formula: 'formulas',
  header: 'headersFooters',
  footer: 'headersFooters',
  footnote: 'footnotes',
  reference: 'references',
};

export function isSkipped(kind: BlockKind, skip: SkipOptions): boolean {
  const key = OPTIONAL[kind];
  return key ? skip[key] : false;
}

export interface ChapterPlan {
  /** What the player reads, in order. */
  items: PlayerItem[];
  /** Sentence id → its position in `items`. */
  orderById: Map<string, number>;
  /** Blocks left out of the voice; the reader dims them. */
  skippedBlocks: Set<string>;
  /** Block id → kind, so the reader can label what it skipped. */
  blockKinds: Map<string, BlockKind>;
  /** Sentence ids that end a block (a paragraph pause follows them). */
  endsBlock: Set<string>;
}

/**
 * Build the queue for one chapter.
 *
 * `pauseMs` is inserted after the last sentence of each block — never after the
 * last block, where the next chapter's first sentence follows instead.
 */
export function planChapter(chapter: Chapter, skip: SkipOptions, pauseMs: number): ChapterPlan {
  const items: PlayerItem[] = [];
  const orderById = new Map<string, number>();
  const skippedBlocks = new Set<string>();
  const blockKinds = new Map<string, BlockKind>();
  const endsBlock = new Set<string>();

  const readBlocks: Block[] = [];
  for (const block of chapter.blocks) {
    blockKinds.set(block.id, block.kind);
    if (isSkipped(block.kind, skip)) {
      skippedBlocks.add(block.id);
      continue;
    }
    if (block.sentences.length === 0) continue;
    readBlocks.push(block);
  }

  for (const block of readBlocks) {
    block.sentences.forEach((sentence, sentenceIndex) => {
      const plan = speakPlan(sentence.text, { citations: skip.citations, brackets: skip.brackets });
      const item: PlayerItem = { id: sentence.id, text: sentence.text };
      if (plan.charMap !== null) {
        item.spoken = plan.text;
        item.charMap = plan.charMap;
      }
      if (sentenceIndex === block.sentences.length - 1) {
        endsBlock.add(sentence.id);
        if (pauseMs > 0) item.pauseAfterMs = pauseMs;
      }
      orderById.set(sentence.id, items.length);
      items.push(item);
    });
  }

  return { items, orderById, skippedBlocks, blockKinds, endsBlock };
}

/** Human label for the dimmed "skipped while reading" mark. */
export function skippedLabel(kind: BlockKind): string {
  switch (kind) {
    case 'table':
      return 'Table';
    case 'figure':
      return 'Figure';
    case 'caption':
      return 'Caption';
    case 'formula':
      return 'Formula';
    case 'header':
    case 'footer':
      return 'Running head';
    case 'footnote':
      return 'Footnote';
    case 'reference':
      return 'Reference';
    default:
      return 'Skipped';
  }
}

/** Settings keys, shared by the reader and the "Reading aloud" section. */
export const SKIP_KEY = {
  tables: 'read.skip.tables',
  figures: 'read.skip.figures',
  captions: 'read.skip.captions',
  formulas: 'read.skip.formulas',
  headersFooters: 'read.skip.headersFooters',
  footnotes: 'read.skip.footnotes',
  references: 'read.skip.references',
  citations: 'read.skip.citations',
  brackets: 'read.skip.brackets',
} as const satisfies Record<keyof SkipOptions, string>;

export const PAUSE_KEY = 'read.pause.paragraphMs';
export const WORD_HIGHLIGHT_KEY = 'read.wordHighlight';
export const DEFAULT_PAUSE_MS = 300;

/** Live skip switches. One hook so the options section and the reader agree. */
export function useSkipOptions(): SkipOptions {
  const tables = useSetting<boolean>(SKIP_KEY.tables, DEFAULT_SKIP.tables);
  const figures = useSetting<boolean>(SKIP_KEY.figures, DEFAULT_SKIP.figures);
  const captions = useSetting<boolean>(SKIP_KEY.captions, DEFAULT_SKIP.captions);
  const formulas = useSetting<boolean>(SKIP_KEY.formulas, DEFAULT_SKIP.formulas);
  const headersFooters = useSetting<boolean>(SKIP_KEY.headersFooters, DEFAULT_SKIP.headersFooters);
  const footnotes = useSetting<boolean>(SKIP_KEY.footnotes, DEFAULT_SKIP.footnotes);
  const references = useSetting<boolean>(SKIP_KEY.references, DEFAULT_SKIP.references);
  const citations = useSetting<boolean>(SKIP_KEY.citations, DEFAULT_SKIP.citations);
  const brackets = useSetting<boolean>(SKIP_KEY.brackets, DEFAULT_SKIP.brackets);
  return useMemo(
    () => ({ tables, figures, captions, formulas, headersFooters, footnotes, references, citations, brackets }),
    [tables, figures, captions, formulas, headersFooters, footnotes, references, citations, brackets]
  );
}
