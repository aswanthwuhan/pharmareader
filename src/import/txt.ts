import type { ParsedDoc } from '../core/types';
import { buildChapters, normaliseText, type BlockSeed } from './blocks';

/** Plain text: a paragraph per blank-line-separated chunk, one chapter. */
export function parseText(text: string, fallbackTitle: string): ParsedDoc {
  const title = normaliseText(fallbackTitle) || 'Text';
  const seeds: BlockSeed[] = text
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => normaliseText(paragraph))
    .filter(Boolean)
    .map((paragraph) => ({ kind: 'p', text: paragraph }));

  return { title, format: 'txt', chapters: buildChapters(seeds, title) };
}
