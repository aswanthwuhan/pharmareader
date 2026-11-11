/**
 * Chapter pre-render core: pure orchestration with injected cache/lexicon
 * dependencies so it can be tested without IndexedDB, workers or the model.
 * `prerender.ts` binds the real `../cache` and `../lexicon` modules.
 */
import type { AudioCacheRecord, TtsEngine } from '../../core/types';
import { cacheVoiceId } from '../cacheIdentity';

export interface PrerenderItem {
  id: string;
  text: string;
}

export interface PrerenderOptions {
  voiceId?: string;
  rate?: number;
  signal?: AbortSignal;
}

export interface PrerenderProgress {
  /** Items visited, including cached ones. */
  done: number;
  total: number;
  /** Every sentence of the chapter is now in the audio cache. */
  synthesised: number;
  skipped: number;
  failed: number;
  /** Item that finished last. */
  id: string;
}

export interface PrerenderReport extends Omit<PrerenderProgress, 'done' | 'id'> {
  done: number;
  aborted: boolean;
  durationMs: number;
}

export interface PrerenderDeps {
  expand(text: string, engineId?: string): Promise<string>;
  cacheKey(text: string, engineId: string, voiceId: string | undefined, rate: number): Promise<string>;
  getAudio(key: string): Promise<AudioCacheRecord | null | undefined>;
  putAudio(record: AudioCacheRecord): Promise<unknown>;
  durationMs?(blob: Blob): Promise<number>;
  /** Cooperative yield so the reader keeps painting between sentences. */
  yield?(): Promise<void>;
  /** Called per failed item instead of throwing; defaults to console.warn. */
  onItemError?(error: unknown, item: PrerenderItem): void;
}

const yieldToUi = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Synthesizes every uncached item, one at a time, writing each result to the
 * audio cache. A single failing sentence never aborts the chapter; an aborted
 * signal does, and also stops the engine's in-flight synthesis.
 */
export async function runPrerender(
  engine: TtsEngine,
  items: PrerenderItem[],
  opts: PrerenderOptions,
  onProgress: ((progress: PrerenderProgress) => void) | undefined,
  deps: PrerenderDeps
): Promise<PrerenderReport> {
  if (!engine.synthesize) {
    throw new Error(`${engine.label} cannot pre-render (no synthesize support)`);
  }
  const synthesize = engine.synthesize.bind(engine);
  const signal = opts.signal;
  const rate = opts.rate ?? 1;
  const yieldControl = deps.yield ?? yieldToUi;
  const startedAt = performance.now();

  const report: PrerenderReport = {
    done: 0,
    total: items.length,
    synthesised: 0,
    skipped: 0,
    failed: 0,
    aborted: false,
    durationMs: 0,
  };

  const onAbort = (): void => engine.stop();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    if (signal?.aborted) {
      report.aborted = true;
      return report;
    }

    for (const item of items) {
      if (signal?.aborted) {
        report.aborted = true;
        break;
      }
      try {
        const text = await deps.expand(item.text, engine.id);
        if (signal?.aborted) {
          report.aborted = true;
          break;
        }
        // Must match the player's key exactly, precision included, or the chapter
        // pre-render would fill the cache with clips playback never looks up.
        const voiceId = await cacheVoiceId(engine, opts.voiceId);
        const key = await deps.cacheKey(text, engine.id, voiceId, rate);
        const cached = await deps.getAudio(key);
        if (signal?.aborted) {
          report.aborted = true;
          break;
        }
        if (cached) {
          report.skipped++;
        } else {
          const audio = await synthesizeOnce(synthesize, text, { voiceId: opts.voiceId, rate }, signal);
          if (signal?.aborted) {
            report.aborted = true;
            break;
          }
          const durationMs = deps.durationMs ? await deps.durationMs(audio) : 0;
          await deps.putAudio({
            key,
            engine: engine.id,
            audio,
            durationMs,
            createdAt: Date.now(),
          });
          report.synthesised++;
        }
      } catch (error) {
        // The abort stopped the engine mid-synthesis, so the rejection is the
        // cancellation, not a broken sentence: do not count it as a failure.
        if (signal?.aborted) {
          report.aborted = true;
          break;
        }
        report.failed++;
        (deps.onItemError ?? logItemError)(error, item);
      }

      report.done++;
      onProgress?.({
        done: report.done,
        total: report.total,
        synthesised: report.synthesised,
        skipped: report.skipped,
        failed: report.failed,
        id: item.id,
      });
      await yieldControl();
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    report.durationMs = Math.round(performance.now() - startedAt);
  }

  return report;
}

function logItemError(error: unknown, item: PrerenderItem): void {
  console.warn(`Pre-render failed for ${item.id}`, error);
}

/**
 * Kokoro native keeps one cancel epoch for playback and pre-render, so a cancel
 * can belong to the other caller. When our own signal never fired, retry the
 * item once; a second cancellation is a real failure.
 */
async function synthesizeOnce(
  synthesize: (text: string, opts: { voiceId?: string; rate: number }) => Promise<Blob>,
  text: string,
  opts: { voiceId?: string; rate: number },
  signal: AbortSignal | undefined
): Promise<Blob> {
  try {
    return await synthesize(text, opts);
  } catch (error) {
    if (signal?.aborted || !/cancel/i.test(error instanceof Error ? error.message : String(error))) {
      throw error;
    }
    return await synthesize(text, opts);
  }
}
