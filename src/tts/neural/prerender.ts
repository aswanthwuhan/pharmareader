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
  runIsPrerendered,
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

/**
 * Whether this chapter's audio is already saved for the current engine, voice
 * and rate. Used to mark chapters that need no rendering; see
 * `runIsPrerendered` for why the cache keys are the test.
 */
export async function isPrerendered(
  engine: TtsEngine,
  items: PrerenderItem[],
  opts: PrerenderOptions = {}
): Promise<boolean> {
  return runIsPrerendered(engine, items, opts, { expand, cacheKey, getAudio, putAudio });
}
