/**
 * Chapter pre-render: expand every sentence through the lexicon, reuse the
 * audio cache, synthesize what is missing. Binding layer only — the loop lives
 * in `prerenderCore.ts` so it stays unit-testable without a model.
 */
import { cacheKey, getAudio, putAudio } from '../cache';
import { expand } from '../lexicon';
import type { TtsEngine } from '../../core/types';
import { audioDurationMs } from './wav';
import {
  runPrerender,
  type PrerenderItem,
  type PrerenderOptions,
  type PrerenderProgress,
  type PrerenderReport,
} from './prerenderCore';

export type { PrerenderItem, PrerenderOptions, PrerenderProgress, PrerenderReport };

/**
 * A chapter's sentences are usually a handful of paragraphs' worth of items;
 * `opts.signal` cancels between sentences and stops the engine mid-sentence.
 */
export async function prerenderChapter(
  engine: TtsEngine,
  items: PrerenderItem[],
  opts: PrerenderOptions = {},
  onProgress?: (progress: PrerenderProgress) => void
): Promise<PrerenderReport> {
  return runPrerender(engine, items, opts, onProgress, {
    expand,
    cacheKey,
    getAudio,
    putAudio,
    durationMs: audioDurationMs,
  });
}
