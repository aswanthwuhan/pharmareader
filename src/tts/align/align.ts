/**
 * Matching the words of a sentence to the words a recogniser heard.
 *
 * Whisper tells us *what* was said and roughly when; the reader needs times for
 * the words on screen, which are the sentence's own words — before the lexicon
 * expanded them. The recogniser also hears things we did not write ("C Y P
 * three A four" for "CYP3A4"), merges two words into one ("can not" →
 * "cannot"), and misses words in noisy clips.
 *
 * So the assignment is a shortest-path search over (sentence word, transcript
 * word): a pair can be matched — one sentence word against a run of up to
 * `MAX_GROUP` transcript words, so a spelled-out drug name still matches — or
 * either side can be skipped for a fixed cost. Matching is always monotonic, so
 * the result can be a highlight moving forward through the sentence. Words that
 * end up unmatched get the time between their matched neighbours.
 */
import { estimateTimings, joinKeys, keyForms, similarity, words } from './text';
import type { TranscriptWord, WordTiming } from './types';

/** Cost of leaving one word unmatched; two skips (1.0) must lose to a match scoring over 0.0. */
const SKIP_SOURCE = 0.5;
const SKIP_TARGET = 0.5;
/** Below this two words are different words, however similar their letters. */
const MIN_SIMILARITY = 0.5;
/** Prefer the shortest run that explains a word ("CYP3A4" beats a whole clause). */
const GROUP_PENALTY = 0.06;
/** The longest run of transcript words one sentence word may absorb. */
const MAX_GROUP = 6;

/** A chunk as Whisper reports it: usually one word, sometimes a word plus its punctuation. */
export interface ChunkTiming {
  text: string;
  startMs: number;
  endMs: number;
}

/**
 * Whisper's word chunks → one entry per word. A chunk carrying several words
 * (rare, but happens around numbers) is split and shares its span by length.
 */
export function transcriptFromChunks(chunks: readonly ChunkTiming[]): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  for (const chunk of chunks) {
    if (!(chunk.endMs > chunk.startMs)) continue;
    const parts = chunk.text.match(/\S+/g);
    if (!parts) continue;
    if (parts.length === 1) {
      out.push({ text: parts[0] as string, startMs: chunk.startMs, endMs: chunk.endMs });
      continue;
    }
    const span = chunk.endMs - chunk.startMs;
    const total = parts.reduce((n, part) => n + part.length + 1, 0);
    let t = chunk.startMs;
    for (let i = 0; i < parts.length; i++) {
      const end = i === parts.length - 1 ? chunk.endMs : t + (span * (parts[i]!.length + 1)) / total;
      out.push({ text: parts[i] as string, startMs: t, endMs: end });
      t = end;
    }
  }
  return out;
}

/**
 * Aligned timings for every word of `text`, or the proportional estimate when
 * the transcript explains nothing (empty, unrelated, or the clip has no length).
 */
export function alignTimings(
  text: string,
  transcript: readonly TranscriptWord[],
  durationMs: number
): WordTiming[] {
  const ranges = words(text);
  const duration = Math.max(0, durationMs);
  if (ranges.length === 0) return [];
  if (transcript.length === 0 || duration === 0) return estimateTimings(text, duration);

  const sourceKeys = ranges.map((range) => keyForms(text.slice(range.charStart, range.charEnd)));
  const targetKeys = transcript.map((word) => keyForms(word.text));
  const n = ranges.length;
  const m = transcript.length;

  // dp[i][j]: best cost for the first i sentence words against the first j
  // transcript words. `step` says how that cell was reached; `group` how many
  // transcript words the match at `step === MATCH` consumed.
  const cols = m + 1;
  const cost = new Float64Array((n + 1) * cols).fill(Number.POSITIVE_INFINITY);
  const step = new Uint8Array((n + 1) * cols);
  const group = new Uint8Array((n + 1) * cols);

  const SKIP_SRC = 1;
  const SKIP_TGT = 2;
  const MATCH = 3;

  cost[0] = 0;
  for (let j = 1; j <= m; j++) {
    cost[j] = cost[j - 1]! + SKIP_TARGET;
    step[j] = SKIP_TGT;
  }

  for (let i = 1; i <= n; i++) {
    const row = i * cols;
    const prev = row - cols;
    cost[row] = cost[prev]! + SKIP_SOURCE;
    step[row] = SKIP_SRC;

    for (let j = 1; j <= m; j++) {
      let best = cost[prev + j]! + SKIP_SOURCE;
      let action = SKIP_SRC;
      let size = 0;

      const skipTarget = cost[row + j - 1]! + SKIP_TARGET;
      if (skipTarget < best) {
        best = skipTarget;
        action = SKIP_TGT;
      }

      const limit = Math.min(MAX_GROUP, j);
      for (let k = 1; k <= limit; k++) {
        const score = similarity(sourceKeys[i - 1]!, joinKeys(targetKeys.slice(j - k, j)));
        if (score < MIN_SIMILARITY) continue;
        const candidate = cost[prev + j - k]! + (1 - score) + GROUP_PENALTY * (k - 1);
        if (candidate < best - 1e-9) {
          best = candidate;
          action = MATCH;
          size = k;
        }
      }

      cost[row + j] = best;
      step[row + j] = action;
      group[row + j] = size;
    }
  }

  // Walk back to collect, per sentence word, the transcript run it matched.
  const matchStart = new Int32Array(n).fill(-1);
  const matchEnd = new Int32Array(n).fill(-1);
  let matched = 0;
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const index = i * cols + j;
    const action = step[index];
    if (action === MATCH) {
      const size = group[index]!;
      matchStart[i - 1] = j - size;
      matchEnd[i - 1] = j;
      matched++;
      j -= size;
      i--;
    } else if (action === SKIP_SRC || j === 0) {
      i--;
    } else {
      j--;
    }
  }

  // Nothing in the transcript looks like this sentence: the estimate is the
  // honest answer (and the caller can still retry with the next clip).
  if (matched === 0) return estimateTimings(text, duration);

  const out: (WordTiming | null)[] = ranges.map((range, i) => {
    if (matchStart[i]! < 0) return null;
    const startMs = transcript[matchStart[i]!]!.startMs;
    const endMs = transcript[matchEnd[i]! - 1]!.endMs;
    return { charStart: range.charStart, charEnd: range.charEnd, startMs, endMs };
  });

  // Words the transcript did not explain ("t½" read as "half-life") take the
  // space between their matched neighbours, split by length.
  for (let i = 0; i < n; i++) {
    if (out[i]) continue;
    let end = i;
    while (end < n && !out[end]) end++;
    const left = i > 0 ? out[i - 1]!.endMs : 0;
    const right = end < n ? out[end]!.startMs : duration;
    const span = Math.max(0, right - left);
    let total = 0;
    for (let k = i; k < end; k++) total += ranges[k]!.charEnd - ranges[k]!.charStart + 1;
    let t = left;
    for (let k = i; k < end; k++) {
      const share = total > 0 ? (span * (ranges[k]!.charEnd - ranges[k]!.charStart + 1)) / total : 0;
      out[k] = { charStart: ranges[k]!.charStart, charEnd: ranges[k]!.charEnd, startMs: t, endMs: t + share };
      t += share;
    }
    i = end - 1;
  }

  // A gap between two words belongs to the word before it: it is usually a word
  // the recogniser heard and we did not write, and no highlight at all reads
  // worse than a slightly long one.
  for (let i = 0; i < n - 1; i++) {
    const current = out[i]!;
    const next = out[i + 1]!;
    if (next.startMs > current.endMs) current.endMs = next.startMs;
  }

  // A highlight can only move forward inside the clip.
  let cursor = 0;
  return out.map((timing) => {
    const startMs = Math.min(Math.max(timing!.startMs, cursor), duration);
    const endMs = Math.min(Math.max(timing!.endMs, startMs), duration);
    cursor = startMs;
    return { charStart: timing!.charStart, charEnd: timing!.charEnd, startMs, endMs };
  });
}
