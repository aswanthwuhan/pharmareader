/**
 * Word timings for read-along word highlighting.
 * Contract used by the player; the Whisper-based aligner (owned by src/tts/align/**) replaces
 * the proportional estimate when its model is installed.
 */
export interface WordTiming {
  /** Character range of the word inside the sentence text that was spoken (before lexicon expansion). */
  charStart: number;
  charEnd: number;
  startMs: number;
  endMs: number;
}

/** Words of `text` with their character ranges. */
export function words(text: string): { charStart: number; charEnd: number }[] {
  const out: { charStart: number; charEnd: number }[] = [];
  for (const m of text.matchAll(/\S+/g)) out.push({ charStart: m.index, charEnd: m.index + m[0].length });
  return out;
}

/**
 * shortcut: timing proportional to word length; upgrade = Whisper alignment (same signature).
 */
export function estimateTimings(text: string, durationMs: number): WordTiming[] {
  const ws = words(text);
  const total = ws.reduce((n, w) => n + (w.charEnd - w.charStart) + 1, 0);
  let t = 0;
  return ws.map((w) => {
    const share = ((w.charEnd - w.charStart + 1) / total) * durationMs;
    const timing = { ...w, startMs: t, endMs: t + share };
    t += share;
    return timing;
  });
}

/** Timings for a synthesized clip. Async so a model-based aligner can slot in. */
export async function wordTimings(_audio: Blob, text: string, durationMs: number): Promise<WordTiming[]> {
  return estimateTimings(text, durationMs);
}
