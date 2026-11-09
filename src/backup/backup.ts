/**
 * Full-device backup: every IndexedDB table as JSON plus, optionally, the
 * original book files. One zip, imported back on this or another device.
 *
 * An imported zip is untrusted input from a trust boundary: entry names are
 * whitelisted, sizes are capped and every record field that the app reads later
 * is type-checked before a single row reaches the database.
 */
import {
  Zip,
  ZipDeflate,
  ZipPassThrough,
  strFromU8,
  strToU8,
  unzip,
  type Unzipped,
  type UnzipFileInfo,
} from 'fflate';
import type { Table } from 'dexie';
import { db } from '../core/db';
import type {
  Block,
  BookRecord,
  Chapter,
  DocFormat,
  Highlight,
  ParsedDoc,
  PdfRect,
  Sentence,
  Setting,
} from '../core/types';

export const BACKUP_APP = 'PharmaReader';
export const BACKUP_SCHEMA = 1;

/**
 * Provider settings are per-device. The key is a credential, and the base URL
 * decides where the key is sent — a backup must never carry either, or
 * importing someone else's zip could silently point the app at their server.
 */
export const PRIVATE_SETTING_PREFIX = 'ai.';

/** The credential itself; kept as a named constant for the export filter. */
export const EXCLUDED_SETTING = 'ai.apiKey';

/** Refuse absurd archives before allocating memory for them. */
const MAX_ZIP_BYTES = 2 * 1024 ** 3;
const MAX_ENTRY_BYTES = 1024 ** 3;
/** Table JSON is parsed in one go, so it gets a tighter cap than book files. */
const MAX_JSON_BYTES = 256 * 1024 ** 2;
const MAX_TOTAL_BYTES = 2 * 1024 ** 3;
const MAX_ROWS = 200_000;

/** Streamed in slices so a big library is never read into memory all at once. */
const READ_CHUNK = 4 * 1024 * 1024;

export type ImportMode = 'merge' | 'replace';

export interface BackupManifest {
  app: string;
  schema: number;
  exportedAt: string;
  counts: Record<string, number>;
}

export interface ImportReport {
  mode: ImportMode;
  counts: Record<string, number>;
  /** Book ids whose original file was not inside the zip. */
  missingFile: string[];
}

const MIME: Record<DocFormat, string> = {
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
};

const FORMATS = ['pdf', 'epub', 'docx', 'txt', 'md', 'html'] as const satisfies readonly DocFormat[];
const HIGHLIGHT_COLORS = ['yellow', 'green', 'blue', 'pink'] as const;
const TOPIC_LEVELS = ['basic', 'intermediate', 'advanced'] as const;
const BLOCK_KINDS = ['p', 'h', 'li', 'table', 'figure'] as const;
const LEXICON_SOURCES = ['builtin', 'user'] as const;

/** Ids end up in zip paths, so no separators and no "..". */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BOOK_FILE_RE = /^books\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.(pdf|epub|docx|txt|md|html)$/;

/** Every table except the audio cache, which is rebuildable and huge. */
function dataTables(): Table[] {
  return db.tables.filter((t) => t.name !== 'audioCache');
}

function isPrivateSetting(row: Setting): boolean {
  return row.key.startsWith(PRIVATE_SETTING_PREFIX);
}

export function backupFileName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `pharmareader-backup-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.zip`;
}

interface ZipEntry {
  name: string;
  data: Uint8Array | Blob;
}

export async function exportBackup({ includeBooks }: { includeBooks: boolean }): Promise<Blob> {
  const entries: ZipEntry[] = [];
  const counts: Record<string, number> = {};

  for (const table of dataTables()) {
    let rows: unknown[] = await table.toArray();
    // Blobs do not belong in the JSON: books travel as raw files instead.
    if (table.name === 'books') rows = rows.map(stripFileBlob);
    if (table.name === 'settings') rows = rows.filter((row) => !isPrivateSetting(row as Setting));
    counts[table.name] = rows.length;
    entries.push({ name: `data/${table.name}.json`, data: strToU8(JSON.stringify(rows, null, 2)) });
  }

  if (includeBooks) {
    for (const book of await db.books.toArray()) {
      // fake-indexeddb (tests) hands blobs back as plain objects.
      if (!(book.fileBlob instanceof Blob)) continue;
      // Already-compressed formats gain nothing from deflate.
      entries.push({ name: `books/${book.id}.${book.format}`, data: book.fileBlob });
    }
  }

  const manifest: BackupManifest = {
    app: BACKUP_APP,
    schema: BACKUP_SCHEMA,
    exportedAt: new Date().toISOString(),
    counts,
  };
  entries.unshift({ name: 'manifest.json', data: strToU8(JSON.stringify(manifest, null, 2)) });

  return buildZip(entries);
}

/**
 * Stream entries into the archive one slice at a time: `zipSync`/`zip` would
 * hold every book in memory at once, which a phone cannot do for a full library.
 */
async function buildZip(entries: ZipEntry[]): Promise<Blob> {
  const parts: Uint8Array[] = [];
  let failure: Error | null = null;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const zip = new Zip((err, chunk, final) => {
    if (err) failure ??= new Error(`Could not build the backup zip: ${err.message}`);
    else if (chunk.length) parts.push(chunk);
    if (final) finish();
  });

  for (const entry of entries) {
    if (failure) break;
    if (entry.data instanceof Blob) {
      const blob: Blob = entry.data;
      const file = new ZipPassThrough(entry.name);
      zip.add(file);
      if (blob.size === 0) file.push(new Uint8Array(0), true);
      for (let offset = 0; offset < blob.size; offset += READ_CHUNK) {
        const end = Math.min(offset + READ_CHUNK, blob.size);
        const chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
        file.push(chunk, end === blob.size);
      }
    } else {
      const file = new ZipDeflate(entry.name, { level: 6 });
      zip.add(file);
      file.push(entry.data, true);
    }
  }

  if (failure) {
    zip.terminate();
    throw failure;
  }
  zip.end();
  await done;
  if (failure) throw failure;
  // fflate types its chunks as Uint8Array<ArrayBufferLike>; Blob takes views.
  return new Blob(parts as unknown as BlobPart[], { type: 'application/zip' });
}

export async function importBackup(file: Blob, mode: ImportMode): Promise<ImportReport> {
  const tables = dataTables();
  const files = await readZip(file, new Set(tables.map((t) => t.name)));
  checkManifest(files);

  // Everything is validated and prepared before the write transaction opens, so
  // a bad record fails with the database untouched.
  const payload = readPayload(files, tables);
  const bookRows = (payload.get('books') ?? []) as Omit<BookRecord, 'fileBlob'>[];
  checkBookFiles(files, bookRows);

  const missingFile: string[] = [];
  const prepared = new Map<string, unknown[]>();
  for (const [name, rows] of payload) {
    prepared.set(
      name,
      name === 'books' ? await attachBookFiles(bookRows, files, mode, missingFile) : rows,
    );
  }

  const counts: Record<string, number> = {};

  await db.transaction('rw', tables, async () => {
    if (mode === 'replace') {
      // Settings survive on purpose: they hold this device's provider config and
      // API key, which the export omits — wiping them would lock the user out.
      for (const table of tables) if (table.name !== 'settings') await table.clear();
    }
    for (const table of tables) {
      const rows = prepared.get(table.name);
      if (!rows || rows.length === 0) continue;
      await (table as Table<unknown, string>).bulkPut(rows);
      counts[table.name] = rows.length;
    }
  });

  return { mode, counts, missingFile };
}

function stripFileBlob(book: unknown): unknown {
  const copy = { ...(book as BookRecord) } as Partial<BookRecord>;
  delete copy.fileBlob;
  return copy;
}

/** Attach the raw file; books whose file is absent get an empty Blob. */
async function attachBookFiles(
  rows: Omit<BookRecord, 'fileBlob'>[],
  files: Unzipped,
  mode: ImportMode,
  missing: string[],
): Promise<BookRecord[]> {
  const books: BookRecord[] = [];
  for (const record of rows) {
    const bytes = files[`books/${record.id}.${record.format}`];
    let fileBlob: Blob;
    if (bytes) {
      fileBlob = new Blob([bytes], { type: MIME[record.format] });
    } else {
      // A merge onto a device that already has the book keeps the local file.
      const existing = mode === 'merge' ? await db.books.get(record.id) : undefined;
      if (existing?.fileBlob instanceof Blob) {
        fileBlob = existing.fileBlob;
      } else {
        fileBlob = new Blob([]);
        missing.push(record.id);
      }
    }
    books.push({ ...record, fileBlob });
  }
  return books;
}

/** A book file may only ship with the book record it belongs to. */
function checkBookFiles(files: Unzipped, books: Omit<BookRecord, 'fileBlob'>[]): void {
  const byId = new Map(books.map((book) => [book.id, book]));
  for (const name of Object.keys(files)) {
    const match = BOOK_FILE_RE.exec(name);
    if (!match) continue;
    const book = byId.get(match[1]);
    if (!book) throw new Error('This backup contains a book file that does not belong to any book in it.');
    if (book.format !== match[2]) throw new Error('This backup has a book file of the wrong type.');
  }
}

function checkManifest(files: Unzipped): void {
  const raw = files['manifest.json'];
  if (!raw) throw new Error('This zip is not a PharmaReader backup (no manifest.json).');
  let parsed: Partial<BackupManifest>;
  try {
    parsed = JSON.parse(strFromU8(raw)) as Partial<BackupManifest>;
  } catch {
    throw new Error('This zip is not a PharmaReader backup (the manifest is not readable).');
  }
  if (parsed.app !== BACKUP_APP) throw new Error('This zip is not a PharmaReader backup.');
  if (parsed.schema !== BACKUP_SCHEMA) {
    throw new Error(`This backup uses format ${String(parsed.schema)}; this app reads format ${BACKUP_SCHEMA}.`);
  }
}

/**
 * Unzip while checking every entry: unknown names, path traversal and oversized
 * entries are refused, and a refused entry is never decompressed.
 */
async function readZip(file: Blob, knownTables: Set<string>): Promise<Unzipped> {
  if (!(file.size <= MAX_ZIP_BYTES)) {
    throw new Error(`That backup is too large (over ${gigabytes(MAX_ZIP_BYTES)}).`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const problems: string[] = [];
  let total = 0;

  const files = await new Promise<Unzipped>((resolve, reject) => {
    unzip(
      bytes,
      {
        filter: (info) => {
          // Directory entries carry no data and are harmless.
          if (info.name.endsWith('/')) return false;
          const problem = entryProblem(info, knownTables);
          if (problem) {
            problems.push(problem);
            return false;
          }
          total += info.originalSize;
          if (total > MAX_TOTAL_BYTES) {
            problems.push(`the archive expands to more than ${gigabytes(MAX_TOTAL_BYTES)}`);
            return false;
          }
          return true;
        },
      },
      (err, data) => (err ? reject(new Error('That file is not a valid zip archive.')) : resolve(data)),
    );
  });

  if (problems.length) throw new Error(`This backup is not safe to import: ${problems[0]}.`);
  return files;
}

function entryProblem(info: UnzipFileInfo, knownTables: Set<string>): string | null {
  const name = info.name;
  if (
    !name ||
    name.includes('\0') ||
    name.includes('\\') ||
    name.startsWith('/') ||
    name.split('/').includes('..')
  ) {
    return `the entry "${name}" has an unsafe path`;
  }
  if (info.originalSize > MAX_ENTRY_BYTES) return `the entry "${name}" is too large`;
  if (name === 'manifest.json') return null;
  const data = /^data\/([A-Za-z0-9]+)\.json$/.exec(name);
  if (data) {
    if (info.originalSize > MAX_JSON_BYTES) return `the table "${data[1]}" is too large`;
    return knownTables.has(data[1]) ? null : `it contains an unknown table "${data[1]}"`;
  }
  if (BOOK_FILE_RE.test(name)) return null;
  return `the entry "${name}" is not part of a PharmaReader backup`;
}

function readPayload(files: Unzipped, tables: Table[]): Map<string, unknown[]> {
  const payload = new Map<string, unknown[]>();
  for (const table of tables) {
    const raw = readTable(files, table.name);
    if (!raw) continue;
    if (raw.length > MAX_ROWS) {
      throw new Error(`This backup is too large: "${table.name}" has more than ${MAX_ROWS} records.`);
    }
    let rows = raw.map((row) => validateRow(table.name, row));
    if (table.name === 'settings') rows = rows.filter((row) => !isPrivateSetting(row as Setting));
    payload.set(table.name, rows);
  }
  return payload;
}

function readTable(files: Unzipped, name: string): unknown[] | undefined {
  const raw = files[`data/${name}.json`];
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(strFromU8(raw));
  } catch {
    throw new Error(`This backup is damaged: data/${name}.json is not readable.`);
  }
  if (!Array.isArray(parsed)) throw new Error(`This backup is damaged: data/${name}.json is not a list.`);
  return parsed;
}

// ---------------------------------------------------------------------------
// Record validation. Every field the app reads later is checked here.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function validateRow(table: string, value: unknown): unknown {
  const raw = asObject(value, `a "${table}" record`);
  switch (table) {
    case 'books':
      return validateBook(raw, `a "books" record`);
    case 'highlights':
      return validateHighlight(raw, `a "highlights" record`);
    case 'bookmarks':
      return validateBookmark(raw, `a "bookmarks" record`);
    case 'cards':
      return validateCard(raw, `a "cards" record`);
    case 'reviewLogs':
      return validateReviewLog(raw, `a "reviewLogs" record`);
    case 'topics':
      return validateTopic(raw, `a "topics" record`);
    case 'lexicon':
      return validateLexicon(raw, `a "lexicon" record`);
    case 'settings':
      return validateSetting(raw, `a "settings" record`);
    default:
      throw new Error(`This backup contains an unknown table "${table}".`);
  }
}

function fail(where: string, field: string): never {
  throw new Error(`This backup is damaged: ${where} has an invalid "${field}" field.`);
}

function asObject(value: unknown, where: string, field = 'record'): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(where, field);
  return value as Row;
}

function readId(value: unknown, where: string, field: string): string {
  if (typeof value !== 'string' || !ID_RE.test(value) || value.includes('..')) fail(where, field);
  return value;
}

function readString(value: unknown, where: string, field: string, max = 4096): string {
  if (typeof value !== 'string' || value.length > max) fail(where, field);
  return value;
}

function readOptionalString(value: unknown, where: string, field: string, max = 4096): string | undefined {
  if (value === undefined || value === null) return undefined;
  return readString(value, where, field, max);
}

function readNumber(value: unknown, where: string, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(where, field);
  return value;
}

function readBool(value: unknown, where: string, field: string): boolean {
  if (typeof value !== 'boolean') fail(where, field);
  return value;
}

function readEnum<T extends string>(
  value: unknown,
  where: string,
  field: string,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail(where, field);
  return value as T;
}

function readArray(value: unknown, where: string, field: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(where, field);
  return value;
}

function readStrings(value: unknown, where: string, field: string, max = 10_000): string[] {
  return readArray(value, where, field, max).map((item, i) => readString(item, where, `${field}[${i}]`));
}

function validateBook(raw: Row, where: string): Omit<BookRecord, 'fileBlob'> {
  const book: Omit<BookRecord, 'fileBlob'> = {
    id: readId(raw.id, where, 'id'),
    title: readString(raw.title, where, 'title', 1000),
    format: readEnum(raw.format, where, 'format', FORMATS),
    addedAt: readNumber(raw.addedAt, where, 'addedAt'),
    parsed: readDoc(raw.parsed, where),
    topicIds: readStrings(raw.topicIds, where, 'topicIds', 500),
  };
  const author = readOptionalString(raw.author, where, 'author', 1000);
  if (author !== undefined) book.author = author;
  const lastPos = readLastPos(raw.lastPos, where);
  if (lastPos) book.lastPos = lastPos;
  return book;
}

function readLastPos(value: unknown, where: string): { chapterId: string; sentenceId: string } | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = asObject(value, where, 'lastPos');
  return {
    chapterId: readString(raw.chapterId, where, 'lastPos.chapterId', 200),
    sentenceId: readString(raw.sentenceId, where, 'lastPos.sentenceId', 200),
  };
}

function readDoc(value: unknown, where: string): ParsedDoc {
  const raw = asObject(value, where, 'parsed');
  const doc: ParsedDoc = {
    title: readString(raw.title, where, 'parsed.title', 1000),
    format: readEnum(raw.format, where, 'parsed.format', FORMATS),
    chapters: readArray(raw.chapters, where, 'parsed.chapters', 5000).map((chapter, i) =>
      readChapter(chapter, where, `parsed.chapters[${i}]`),
    ),
  };
  const author = readOptionalString(raw.author, where, 'parsed.author', 1000);
  if (author !== undefined) doc.author = author;
  return doc;
}

function readChapter(value: unknown, where: string, field: string): Chapter {
  const raw = asObject(value, where, field);
  return {
    id: readString(raw.id, where, `${field}.id`, 200),
    title: readString(raw.title, where, `${field}.title`, 1000),
    blocks: readArray(raw.blocks, where, `${field}.blocks`, 50_000).map((block, i) =>
      readBlock(block, where, `${field}.blocks[${i}]`),
    ),
  };
}

function readBlock(value: unknown, where: string, field: string): Block {
  const raw = asObject(value, where, field);
  return {
    id: readString(raw.id, where, `${field}.id`, 200),
    kind: readEnum(raw.kind, where, `${field}.kind`, BLOCK_KINDS),
    sentences: readArray(raw.sentences, where, `${field}.sentences`, 50_000).map((sentence, i) =>
      readSentence(sentence, where, `${field}.sentences[${i}]`),
    ),
  };
}

function readSentence(value: unknown, where: string, field: string): Sentence {
  const raw = asObject(value, where, field);
  const sentence: Sentence = {
    id: readString(raw.id, where, `${field}.id`, 200),
    text: readString(raw.text, where, `${field}.text`, 20_000),
  };
  if (raw.pdfRects !== undefined && raw.pdfRects !== null) {
    sentence.pdfRects = readArray(raw.pdfRects, where, `${field}.pdfRects`, 5000).map((rect, i) =>
      readRect(rect, where, `${field}.pdfRects[${i}]`),
    );
  }
  const cfi = readOptionalString(raw.cfi, where, `${field}.cfi`, 2000);
  if (cfi !== undefined) sentence.cfi = cfi;
  return sentence;
}

function readRect(value: unknown, where: string, field: string): PdfRect {
  const raw = asObject(value, where, field);
  return {
    page: readNumber(raw.page, where, `${field}.page`),
    x: readNumber(raw.x, where, `${field}.x`),
    y: readNumber(raw.y, where, `${field}.y`),
    w: readNumber(raw.w, where, `${field}.w`),
    h: readNumber(raw.h, where, `${field}.h`),
  };
}

function validateHighlight(raw: Row, where: string): Highlight {
  const highlight: Highlight = {
    id: readId(raw.id, where, 'id'),
    bookId: readId(raw.bookId, where, 'bookId'),
    sentenceIds: readStrings(raw.sentenceIds, where, 'sentenceIds'),
    text: readString(raw.text, where, 'text', 100_000),
    color: readEnum(raw.color, where, 'color', HIGHLIGHT_COLORS),
    topicIds: readStrings(raw.topicIds, where, 'topicIds', 500),
    createdAt: readNumber(raw.createdAt, where, 'createdAt'),
  };
  const note = readOptionalString(raw.note, where, 'note', 100_000);
  if (note !== undefined) highlight.note = note;
  return highlight;
}

function validateBookmark(raw: Row, where: string) {
  const bookmark = {
    id: readId(raw.id, where, 'id'),
    bookId: readId(raw.bookId, where, 'bookId'),
    chapterId: readString(raw.chapterId, where, 'chapterId', 200),
    sentenceId: readString(raw.sentenceId, where, 'sentenceId', 200),
    createdAt: readNumber(raw.createdAt, where, 'createdAt'),
  };
  const label = readOptionalString(raw.label, where, 'label', 1000);
  return label === undefined ? bookmark : { ...bookmark, label };
}

function validateCard(raw: Row, where: string) {
  const card = {
    id: readId(raw.id, where, 'id'),
    kind: readEnum(raw.kind, where, 'kind', ['qa', 'cloze'] as const),
    front: readString(raw.front, where, 'front', 20_000),
    back: readString(raw.back, where, 'back', 20_000),
    topicIds: readStrings(raw.topicIds, where, 'topicIds', 500),
    fsrs: raw.fsrs ?? {},
    createdAt: readNumber(raw.createdAt, where, 'createdAt'),
  };
  const bookId = readOptionalId(raw.bookId, where, 'bookId');
  const highlightId = readOptionalId(raw.highlightId, where, 'highlightId');
  return {
    ...card,
    ...(bookId === undefined ? {} : { bookId }),
    ...(highlightId === undefined ? {} : { highlightId }),
  };
}

function readOptionalId(value: unknown, where: string, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return readId(value, where, field);
}

function validateReviewLog(raw: Row, where: string) {
  return {
    id: readId(raw.id, where, 'id'),
    cardId: readId(raw.cardId, where, 'cardId'),
    rating: readNumber(raw.rating, where, 'rating'),
    reviewedAt: readNumber(raw.reviewedAt, where, 'reviewedAt'),
    log: raw.log ?? {},
  };
}

function validateTopic(raw: Row, where: string) {
  const topic = {
    id: readId(raw.id, where, 'id'),
    parentId: raw.parentId === null || raw.parentId === undefined ? null : readId(raw.parentId, where, 'parentId'),
    title: readString(raw.title, where, 'title', 1000),
    level: readEnum(raw.level, where, 'level', TOPIC_LEVELS),
    order: readNumber(raw.order, where, 'order'),
  };
  const custom = raw.custom;
  if (custom === undefined || custom === null) return topic;
  return { ...topic, custom: readBool(custom, where, 'custom') };
}

function validateLexicon(raw: Row, where: string) {
  return {
    id: readId(raw.id, where, 'id'),
    pattern: readString(raw.pattern, where, 'pattern', 2000),
    replacement: readString(raw.replacement, where, 'replacement', 2000),
    isRegex: readBool(raw.isRegex, where, 'isRegex'),
    source: readEnum(raw.source, where, 'source', LEXICON_SOURCES),
    enabled: readBool(raw.enabled, where, 'enabled'),
  };
}

function validateSetting(raw: Row, where: string): Setting {
  if (!('value' in raw)) fail(where, 'value');
  return { key: readString(raw.key, where, 'key', 200), value: raw.value };
}

function gigabytes(bytes: number): string {
  return `${Math.round(bytes / 1024 ** 3)} GB`;
}
