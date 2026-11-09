/**
 * Shared shapes of the read-along aligner.
 *
 * `WordTiming` addresses the sentence as the reader sees it; `TranscriptWord` is
 * one word the recogniser heard, with its own time span inside the clip.
 */
export interface WordTiming {
  /** Character range of the word inside the sentence text that was spoken (before lexicon expansion). */
  charStart: number;
  charEnd: number;
  startMs: number;
  endMs: number;
}

/** One recognised word and when it was said, in milliseconds from the clip start. */
export interface TranscriptWord {
  text: string;
  startMs: number;
  endMs: number;
}
