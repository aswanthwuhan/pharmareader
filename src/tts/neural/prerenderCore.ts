/**
 * Chapter pre-render core: pure orchestration with injected cache/lexicon
 * dependencies so it can be tested without IndexedDB, workers or the model.
 * `prerender.ts` binds the real `../cache` and `../lexicon` modules.
 */
import type { AudioCacheRecord, TtsEngine } from '../../core/types';

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
  expand(text: string): Promise<string>;
  lexiconVersion(): Promise<string>;
  cacheKey(
    text: string,
    engineId: string,
    voiceId: string | undefined,
    rate: number,
    lexVersion: string
  ): Promise<string>;
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
    const version = await deps.lexiconVersion();

    for (const item of items) {
      if (signal?.aborted) {
        report.aborted = true;
        break;
      }
      try {
        const text = await deps.expand(item.text);
        const key = await deps.cacheKey(text, engine.id, opts.voiceId, rate, version);
        const cached = await deps.getAudio(key);
        if (cached) {
          report.skipped++;
        } else {
          const audio = await synthesize(text, { voiceId: opts.voiceId, rate });
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
