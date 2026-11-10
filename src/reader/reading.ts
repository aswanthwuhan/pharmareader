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
import { useLiveQuery } from 'dexie-react-hooks';
import type { Block, Chapter } from '../core/types';
import { getSetting, useSetting } from '../core/settings';
import type { PlayerItem } from '../tts/player';
import { speakPlan, type BracketMode } from './spoken';

/** The kinds a parsed block can carry ('p' | 'h' | 'li' | 'table' | …). */
export type BlockKind = Block['kind'];

/** Keys whose value is an on/off switch (brackets is a three-way mode). */
type SwitchKey = Exclude<keyof SkipOptions, 'brackets'>;

export interface SkipOptions {
  tables: boolean;
  figures: boolean;
  captions: boolean;
  formulas: boolean;
  headersFooters: boolean;
  footnotes: boolean;
  references: boolean;
  citations: boolean;
  /** How bracketed asides are spoken; see `BracketMode`. */
  brackets: BracketMode;
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
  brackets: 'announce',
};

/** Kinds that are read only when their switch is on. */
const OPTIONAL: Partial<Record<BlockKind, SwitchKey>> = {
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

/** Only whole, readable sentences are planned; a formula is never announced. */
function itemFor(text: string, id: string, skip: SkipOptions, kind: BlockKind): PlayerItem {
  const plan = speakPlan(text, {
    citations: skip.citations,
    // Equations are read exactly as printed: "in brackets" would be noise in the
    // middle of a structure.
    brackets: kind === 'formula' ? 'read' : skip.brackets,
  });
  const item: PlayerItem = { id, text };
  if (plan.charMap !== null) {
    item.spoken = plan.text;
    item.charMap = plan.charMap;
  }
  return item;
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
      const item = itemFor(sentence.text, sentence.id, skip, block.kind);
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

/**
 * The queue for a hand-picked selection, in the order the reader chose.
 *
 * A selection wins over the skip switches: asking to play a table row aloud is
 * an explicit request, so even a skipped sentence is spoken. Sentences keep the
 * spoken form (citations, brackets) they would have had in the chapter queue.
 */
export function planSelection(
  chapter: Chapter,
  ids: readonly string[],
  skip: SkipOptions,
  pauseMs: number
): PlayerItem[] {
  const planned = new Map(planChapter(chapter, skip, pauseMs).items.map((item) => [item.id, item]));
  const texts = new Map<string, { text: string; kind: BlockKind }>();
  for (const block of chapter.blocks) {
    for (const sentence of block.sentences) texts.set(sentence.id, { text: sentence.text, kind: block.kind });
  }

  const items: PlayerItem[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const already = planned.get(id);
    if (already) {
      // A selection stops where it ends, so it takes no paragraph pause with it.
      const { pauseAfterMs: _pause, ...rest } = already;
      items.push(rest);
      continue;
    }
    const found = texts.get(id);
    if (!found) continue; // ids from another chapter are ignored, not fatal
    items.push(itemFor(found.text, id, skip, found.kind));
  }
  return items;
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

/** Three-way bracket setting. */
export const BRACKET_KEY = 'read.brackets';
/** Old on/off switch; `true` meant "skip asides". Read once, never written. */
export const LEGACY_BRACKET_KEY = SKIP_KEY.brackets;

export const PAUSE_KEY = 'read.pause.paragraphMs';
export const WORD_HIGHLIGHT_KEY = 'read.wordHighlight';
export const DEFAULT_PAUSE_MS = 300;

export function isBracketMode(value: unknown): value is BracketMode {
  return value === 'announce' || value === 'read' || value === 'skip';
}

/** `read.brackets` wins; a legacy `read.skip.brackets: true` still means "skip". */
export function resolveBracketMode(current: unknown, legacy: unknown): BracketMode {
  if (isBracketMode(current)) return current;
  return legacy === true ? 'skip' : DEFAULT_SKIP.brackets;
}

/** Live bracket mode, migrated from the old boolean on first read. */
export function useBracketMode(): BracketMode {
  return useLiveQuery(
    async () => {
      const current = await getSetting<unknown>(BRACKET_KEY, undefined);
      if (isBracketMode(current)) return current;
      const legacy = await getSetting<unknown>(LEGACY_BRACKET_KEY, undefined);
      return resolveBracketMode(current, legacy);
    },
    [],
    DEFAULT_SKIP.brackets
  );
}

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
  const brackets = useBracketMode();
  return useMemo(
    () => ({ tables, figures, captions, formulas, headersFooters, footnotes, references, citations, brackets }),
    [tables, figures, captions, formulas, headersFooters, footnotes, references, citations, brackets]
  );
}
