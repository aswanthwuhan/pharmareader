/**
 * Shared domain contracts for PharmaReader.
 *
 * Every feature area (import, reader, tts, study, syllabus, ai, backup) codes
 * against these types. Keep them serialisable: they are stored in IndexedDB and
 * exported to a backup zip, so no class instances or functions here.
 */

// Type-only: the layout code owns the union, and a book records the same three
// choices. The import is erased, so this file still has no runtime dependency.
import type { ColumnMode } from '../import/layout/assign';

export type { ColumnMode };

/** Source file format of an imported document. */
export type DocFormat = 'pdf' | 'epub' | 'docx' | 'txt' | 'md' | 'html';

/**
 * A highlight rectangle on a PDF page.
 * Coordinates are PDF user-space units, origin top-left after the viewport
 * transform at scale 1 (i.e. the same space pdfjs-dist renders into at scale 1).
 */
export interface PdfRect {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Smallest unit the reader and TTS work on. */
export interface Sentence {
  id: string;
  text: string;
  /** Locators for PDF page view. Absent for reflow-only formats. */
  pdfRects?: PdfRect[];
  /** EPUB CFI locator, used to jump back into the ebook. */
  cfi?: string;
}

/**
 * Every block kind an importer may emit. Backup validation reads this list, so a
 * new kind added here is restorable without a second edit.
 */
export const BLOCK_KINDS = [
  'p',
  'h',
  'li',
  'table',
  'figure',
  'caption',
  'formula',
  'header',
  'footer',
  'footnote',
  'reference',
  'code',
] as const;

/** A content block inside a chapter. */
export interface Block {
  id: string;
  /**
   * Layout role. 'p'/'h'/'li' are body text; the rest come from layout detection
   * (PP-DocLayout on PDFs, DOM structure elsewhere) and can be skipped when reading aloud.
   */
  kind: (typeof BLOCK_KINDS)[number];
  sentences: Sentence[];
}

export interface Chapter {
  id: string;
  title: string;
  blocks: Block[];
}

/** Normalised document produced by every extractor in `src/import`. */
export interface ParsedDoc {
  title: string;
  author?: string;
  format: DocFormat;
  chapters: Chapter[];
}

/** A book in the library, with its original file kept for backup/export. */
export interface BookRecord {
  id: string;
  title: string;
  author?: string;
  format: DocFormat;
  addedAt: number;
  fileBlob: Blob;
  parsed: ParsedDoc;
  topicIds: string[];
  lastPos?: { chapterId: string; sentenceId: string };
  /**
   * PDFs only: what read the page layout of `parsed` — the PP-DocLayout model, or
   * the text heuristics alone. Absent on books imported before this was recorded.
   */
  layout?: 'model' | 'heuristic';
  /**
   * PDFs only: how the page's columns are read. Absent means `'auto'` — books
   * imported before this could be chosen keep detecting the columns.
   */
  columns?: ColumnMode;
}

/** A user highlight over one or more sentences. */
export interface Highlight {
  id: string;
  bookId: string;
  sentenceIds: string[];
  text: string;
  color: 'yellow' | 'green' | 'blue' | 'pink';
  note?: string;
  topicIds: string[];
  createdAt: number;
}

export interface Bookmark {
  id: string;
  bookId: string;
  chapterId: string;
  sentenceId: string;
  label?: string;
  createdAt: number;
}

/** A flashcard; `fsrs` holds a serialised ts-fsrs Card. */
export interface CardRecord {
  id: string;
  bookId?: string;
  highlightId?: string;
  kind: 'qa' | 'cloze';
  front: string;
  back: string;
  topicIds: string[];
  fsrs: unknown /* ts-fsrs Card serialized */;
  createdAt: number;
}

export interface ReviewLogRecord {
  id: string;
  cardId: string;
  rating: number;
  reviewedAt: number;
  log: unknown;
}

/** Node of the NMC MD Pharmacology syllabus tree. */
export interface Topic {
  id: string;
  parentId: string | null;
  title: string;
  level: 'basic' | 'intermediate' | 'advanced';
  order: number;
  custom?: boolean;
}

/** Pronunciation rewrite applied to text before any TTS engine speaks it. */
export interface LexiconEntry {
  id: string;
  pattern: string;
  replacement: string;
  isRegex: boolean;
  source: 'builtin' | 'user';
  enabled: boolean;
}

/** Pre-rendered audio, keyed by hash(text + voice + rate + lexicon version). */
export interface AudioCacheRecord {
  key: string;
  engine: string;
  audio: Blob;
  durationMs: number;
  createdAt: number;
}

export interface Setting {
  key: string;
  value: unknown;
}

export interface TtsVoice {
  id: string;
  name: string;
  lang: string;
}

export interface TtsCapabilities {
  streaming: boolean;
  prerender: boolean;
  wordBoundaries: boolean;
  needsDownload: boolean;
}

/** Callbacks an engine fires while speaking. */
export interface SpeakEvents {
  onStart?(sentenceId: string): void;
  onEnd?(sentenceId: string): void;
  onWord?(sentenceId: string, charIndex: number): void;
  onError?(err: Error): void;
}

/** Contract every TTS engine (system, pocket, kokoro) implements. */
export interface TtsEngine {
  id: 'system' | 'pocket' | 'kokoro';
  label: string;
  capabilities: TtsCapabilities;
  isReady(): Promise<boolean>;
  prepare(onProgress?: (fraction: number) => void): Promise<void>; // downloads/loads model; no-op for system
  listVoices(): Promise<TtsVoice[]>;
  /** Speak sentences in order; resolves when all done or stopped. Text is already lexicon-expanded by caller. */
  speak(items: { id: string; text: string }[], opts: { voiceId?: string; rate: number }, ev: SpeakEvents): Promise<void>;
  stop(): void;
  pause(): void;
  resume(): void;
  /** Optional: render to audio blob (for cache/pre-render). */
  synthesize?(text: string, opts: { voiceId?: string; rate: number }): Promise<Blob>;
}
