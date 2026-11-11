import { strFromU8, strToU8, unzipSync, zipSync, type Unzipped } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../core/db';
import { getSetting, setSetting } from '../core/settings';
import { BLOCK_KINDS, type Block, type BookRecord, type CardRecord, type Highlight } from '../core/types';
import {
  BACKUP_APP,
  BACKUP_SCHEMA,
  LAST_EXPORT_SETTING,
  backupFileName,
  exportBackup,
  importBackup,
  lastBackupLabel,
  type BackupManifest,
} from './backup';

const NOW = 1_700_000_000_000;

function book(id: string): BookRecord {
  return {
    id,
    title: `Book ${id}`,
    format: 'txt',
    addedAt: NOW,
    fileBlob: new Blob(['pharmacology text']),
    parsed: { title: `Book ${id}`, format: 'txt', chapters: [] },
    topicIds: [],
  };
}

/** A PDF with a block of every kind, pdfRects and cfi — what restoring must keep. */
function pdfBook(): BookRecord {
  const blocks: Block[] = BLOCK_KINDS.map((kind, index) => ({
    id: `blk-${index}`,
    kind,
    sentences: [
      {
        id: `s-${index}`,
        text: `A ${kind} sentence.`,
        pdfRects: [{ page: index + 1, x: 72, y: 100 + index, w: 300, h: 12 }],
        cfi: `/6/2[ch1]!/4/2[s${index}]/1:0`,
      },
    ],
  }));
  return {
    id: 'b1',
    title: 'Basic & Clinical Pharmacology',
    author: 'Bertram G. Katzung',
    format: 'pdf',
    addedAt: NOW,
    fileBlob: new Blob(['%PDF-1.4 fake'], { type: 'application/pdf' }),
    parsed: {
      title: 'Basic & Clinical Pharmacology',
      author: 'Bertram G. Katzung',
      format: 'pdf',
      chapters: [{ id: 'ch1', title: 'Pharmacokinetics', blocks }],
    },
    topicIds: ['t1', 't2'],
    lastPos: { chapterId: 'ch1', sentenceId: 's-3' },
  };
}

function highlight(id: string, bookId: string): Highlight {
  return {
    id,
    bookId,
    sentenceIds: ['s1'],
    text: 'Aspirin inhibits COX-1.',
    color: 'yellow',
    topicIds: [],
    createdAt: NOW,
  };
}

function card(id: string, bookId: string): CardRecord {
  return { id, bookId, kind: 'qa', front: 'Q', back: 'A', topicIds: [], fsrs: {}, createdAt: NOW };
}

/** Every table, with realistic rows for a restore to lose. */
async function seedLibrary(): Promise<void> {
  await db.books.put(pdfBook());
  await db.books.put(book('b2'));
  await db.highlights.put({ ...highlight('h1', 'b1'), note: 'Exam favourite — half-life 4 h.', sentenceIds: ['s-0', 's-1'] });
  await db.highlights.put(highlight('h2', 'b2'));
  await db.bookmarks.put({
    id: 'm1',
    bookId: 'b1',
    chapterId: 'ch1',
    sentenceId: 's-3',
    label: 'Kinetics formula',
    createdAt: NOW,
  });
  await db.cards.put({
    id: 'c1',
    bookId: 'b1',
    highlightId: 'h1',
    kind: 'cloze',
    front: 'Aspirin inhibits {{c1::COX-1}}.',
    back: 'Aspirin inhibits COX-1.',
    topicIds: ['t2'],
    fsrs: { due: NOW + 86_400_000, stability: 2.5, difficulty: 4.1, reps: 3, lapses: 0, state: 2 },
    createdAt: NOW,
  });
  await db.cards.put(card('c2', 'b2'));
  await db.reviewLogs.put({
    id: 'r1',
    cardId: 'c1',
    rating: 3,
    reviewedAt: NOW,
    log: { elapsed: 12_340, scheduled: 86_400_000, state: 2 },
  });
  await db.topics.put({ id: 't1', parentId: null, title: 'Pharmacology', level: 'intermediate', order: 1, custom: true });
  await db.topics.put({ id: 't2', parentId: 't1', title: 'Pharmacokinetics', level: 'basic', order: 2 });
  await db.lexicon.put({
    id: 'l1',
    pattern: 't½',
    replacement: 'half-life',
    isRegex: false,
    source: 'user',
    enabled: true,
  });
  await db.settings.put({ key: 'theme', value: 'dark' });
  await db.settings.put({ key: 'reader.fontSize', value: 19 });
  // Where the reader reopens each book: a setting, keyed by book id.
  await db.settings.put({ key: 'reader.lastPos.b1', value: { chapterId: 'ch1', sentenceId: 's-3' } });
}

async function clearAll(): Promise<void> {
  for (const table of db.tables) await table.clear();
}

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of db.tables) out[table.name] = await table.count();
  return out;
}

const byId = (a: { id?: string }, b: { id?: string }) => String(a.id).localeCompare(String(b.id));

/**
 * The database as a restore should reproduce it. fileBlob is left out because
 * fake-indexeddb cannot hold a Blob, and ai.* settings are per-device.
 */
async function snapshot(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const table of db.tables) {
    const rows = (await table.toArray()) as Record<string, unknown>[];
    if (table.name === 'books') {
      out.books = rows.map((row) => {
        const copy = { ...row };
        delete copy.fileBlob;
        return copy;
      });
      out.books = (out.books as Record<string, unknown>[]).sort(byId);
      continue;
    }
    if (table.name === 'settings') {
      out.settings = rows.filter((row) => !String(row.key).startsWith('ai.')).sort(byId);
      continue;
    }
    out[table.name] = rows.sort(byId);
  }
  return out;
}

async function openZip(blob: Blob): Promise<Unzipped> {
  return unzipSync(new Uint8Array(await blob.arrayBuffer()));
}

function readJson<T>(files: Unzipped, path: string): T {
  return JSON.parse(strFromU8(files[path])) as T;
}

async function craftZip(files: Record<string, Uint8Array>): Promise<Blob> {
  return new Blob([zipSync(files)]);
}

const manifest = (schema = BACKUP_SCHEMA) => strToU8(JSON.stringify({ app: BACKUP_APP, schema }));

/** A book record as it sits inside a zip: no binary, since it travels as a file. */
function record(bookRecord: BookRecord): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...bookRecord };
  delete copy.fileBlob;
  return copy;
}

/**
 * A zip exactly as v0.2.0 wrote it (schema 1): every table pretty-printed,
 * every book in one data/books.json, the original files beside it.
 */
async function v02Zip(extraFiles: Record<string, Uint8Array> = {}): Promise<Blob> {
  const files: Record<string, Uint8Array> = { ...extraFiles };
  const counts: Record<string, number> = {};
  for (const table of db.tables) {
    if (table.name === 'audioCache') continue;
    const rows = (await table.toArray()) as Record<string, unknown>[];
    const out = table.name === 'books' ? rows.map((row) => stripRowBlob(row)) : rows;
    counts[table.name] = out.length;
    files[`data/${table.name}.json`] = strToU8(JSON.stringify(out, null, 2));
  }
  const parsed: BackupManifest = {
    app: BACKUP_APP,
    schema: 1,
    exportedAt: new Date(NOW).toISOString(),
    counts,
  };
  files['manifest.json'] = strToU8(JSON.stringify(parsed, null, 2));
  return craftZip(files);
}

function stripRowBlob(row: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...row };
  delete copy.fileBlob;
  return copy;
}

beforeEach(async () => {
  await clearAll();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('exportBackup', () => {
  it('writes a manifest and one compact JSON entry per table, without the API key or blobs', async () => {
    await db.books.put(book('b1'));
    await db.highlights.put(highlight('h1', 'b1'));
    await db.cards.put(card('c1', 'b1'));
    await db.settings.put({ key: 'ai.apiKey', value: 'sk-secret' });
    await db.settings.put({ key: 'theme', value: 'dark' });
    await db.audioCache.put({ key: 'a1', engine: 'system', audio: new Blob(['x']), durationMs: 1, createdAt: NOW });

    const files = await openZip(await exportBackup({ includeBooks: false }));

    const parsed = readJson<BackupManifest>(files, 'manifest.json');
    expect(parsed.app).toBe(BACKUP_APP);
    expect(parsed.schema).toBe(BACKUP_SCHEMA);
    expect(parsed.counts.books).toBe(1);
    expect(parsed.counts.cards).toBe(1);
    expect(Date.parse(parsed.exportedAt)).toBeGreaterThan(0);

    const settings = readJson<{ key: string }[]>(files, 'data/settings.json');
    expect(settings.map((s) => s.key)).toEqual(['theme']);
    expect(JSON.stringify(settings)).not.toContain('sk-secret');

    // Schema 2: the book record has its own entry and no binary field.
    expect(files['data/books.json']).toBeUndefined();
    const books = readJson<Record<string, unknown>>(files, 'data/books/b1.json');
    expect(books).not.toHaveProperty('fileBlob');
    expect(books).toHaveProperty('id', 'b1');
    expect(books).toHaveProperty('title', 'Book b1');

    expect(files['data/audioCache.json']).toBeUndefined();
  });

  it('writes JSON without indentation', async () => {
    await db.books.put(pdfBook());
    await db.settings.put({ key: 'theme', value: 'dark' });
    const files = await openZip(await exportBackup({ includeBooks: false }));

    for (const path of ['manifest.json', 'data/settings.json', 'data/books/b1.json']) {
      const raw = strFromU8(files[path]!);
      expect(raw).not.toContain('\n');
      expect(raw).toBe(JSON.stringify(JSON.parse(raw)));
    }
  });

  it('names the file after the export date', () => {
    expect(backupFileName(new Date(2026, 0, 9, 7, 5))).toBe('pharmareader-backup-2026-01-09-0705.zip');
  });

  it('includes raw book files when asked', async () => {
    await db.books.put(book('b1'));
    const files = await openZip(await exportBackup({ includeBooks: true }));
    // fake-indexeddb hands blobs back as plain objects, so no file can be written here;
    // the manifest must still list the book.
    expect(readJson<BackupManifest>(files, 'manifest.json').counts.books).toBe(1);
    expect(Object.keys(files).some((name) => name.startsWith('books/'))).toBe(false);
  });
});

describe('importBackup: round trip', () => {
  it('restores every table, with every field, for a backup with and without books', async () => {
    await seedLibrary();
    const before = await snapshot();

    for (const includeBooks of [false, true]) {
      const blob = await exportBackup({ includeBooks });
      await clearAll();
      const report = await importBackup(blob, 'replace');

      expect(await snapshot()).toEqual(before);
      // fake-indexeddb cannot store a Blob, so the two book files never travel.
      expect(report.missingFile).toEqual(['b1', 'b2']);
      expect(report.counts.books).toBe(2);
      // The reading position is a settings row, not a book field, and must travel too.
      expect(await getSetting('reader.lastPos.b1', null)).toEqual({ chapterId: 'ch1', sentenceId: 's-3' });
    }
  });

  it('keeps a book record whose parsed document has every block kind', async () => {
    await seedLibrary();
    const blob = await exportBackup({ includeBooks: true });
    await clearAll();
    await importBackup(blob, 'replace');

    const restored = await db.books.get('b1');
    const blocks = restored?.parsed.chapters[0]?.blocks ?? [];
    expect(blocks.map((block) => block.kind)).toEqual([...BLOCK_KINDS]);
    expect(blocks[0]?.sentences[0]?.pdfRects).toEqual([{ page: 1, x: 72, y: 100, w: 300, h: 12 }]);
    expect(blocks[0]?.sentences[0]?.cfi).toBe('/6/2[ch1]!/4/2[s0]/1:0');
    expect(restored?.author).toBe('Bertram G. Katzung');
    expect(restored?.lastPos).toEqual({ chapterId: 'ch1', sentenceId: 's-3' });
  });

  it('keeps the layout flag that decides how sentences are placed on the page', async () => {
    await db.books.put({ ...book('b1'), layout: 'model' });
    await db.books.put(book('b2'));

    const blob = await exportBackup({ includeBooks: false });
    const files = await openZip(blob);
    expect(readJson<Record<string, unknown>>(files, 'data/books/b1.json')).toMatchObject({ layout: 'model' });

    await clearAll();
    await importBackup(blob, 'replace');

    expect((await db.books.get('b1'))?.layout).toBe('model');
    // A book parsed before the layout models existed has no flag, and must not gain one.
    expect(await db.books.get('b2')).not.toHaveProperty('layout');
  });

  it("keeps a PDF's column choice, and does not give one to a book that has none", async () => {
    await db.books.put({ ...book('b1'), columns: 2 });
    await db.books.put(book('b2'));

    const blob = await exportBackup({ includeBooks: false });
    const files = await openZip(blob);
    expect(readJson<Record<string, unknown>>(files, 'data/books/b1.json')).toMatchObject({ columns: 2 });

    await clearAll();
    await importBackup(blob, 'replace');

    expect((await db.books.get('b1'))?.columns).toBe(2);
    // No choice stored means "detect": the restore must not make the book look
    // as if the reader had picked one, or Re-analyse would read it differently.
    expect(await db.books.get('b2')).not.toHaveProperty('columns');
  });

  it('restores a card with its fsrs state and a highlight with its note', async () => {
    await seedLibrary();
    const blob = await exportBackup({ includeBooks: false });
    await clearAll();
    await importBackup(blob, 'replace');

    const restoredCard = await db.cards.get('c1');
    expect(restoredCard?.fsrs).toEqual({
      due: NOW + 86_400_000,
      stability: 2.5,
      difficulty: 4.1,
      reps: 3,
      lapses: 0,
      state: 2,
    });
    expect(restoredCard?.highlightId).toBe('h1');
    expect(restoredCard?.bookId).toBe('b1');

    const restoredHighlight = await db.highlights.get('h1');
    expect(restoredHighlight?.note).toBe('Exam favourite — half-life 4 h.');
    expect(restoredHighlight?.sentenceIds).toEqual(['s-0', 's-1']);

    expect(await db.reviewLogs.get('r1')).toMatchObject({ log: { elapsed: 12_340, scheduled: 86_400_000 } });
    expect(await db.bookmarks.get('m1')).toMatchObject({ label: 'Kinetics formula' });
    expect(await db.topics.get('t1')).toMatchObject({ custom: true });
    expect(await db.topics.get('t2')).toMatchObject({ parentId: 't1' });
    expect(await db.lexicon.get('l1')).toMatchObject({ source: 'user' });
  });

  it('round-trips a replace: every table comes back with the same counts', async () => {
    await seedLibrary();
    const before = await counts();
    const blob = await exportBackup({ includeBooks: false });

    await clearAll();
    // The device keeps its own key across a restore; the backup never had it.
    await setSetting('ai.apiKey', 'sk-secret');

    const report = await importBackup(blob, 'replace');

    // Settings are never cleared by a replace, so the device's own key adds a row.
    const after = await counts();
    delete after.settings;
    const beforeNoSettings = { ...before };
    delete beforeNoSettings.settings;
    expect(after).toEqual(beforeNoSettings);
    expect(report.mode).toBe('replace');
    expect(report.counts.books).toBe(2);
    expect(report.counts.highlights).toBe(2);
    expect(await getSetting('ai.apiKey', '')).toBe('sk-secret');
    expect(await getSetting('theme', 'light')).toBe('dark');
    expect(await getSetting('reader.fontSize', 0)).toBe(19);
  });

  it('replace drops rows that are not in the backup', async () => {
    await db.highlights.put(highlight('h1', 'b1'));
    const blob = await exportBackup({ includeBooks: false });

    await db.highlights.put(highlight('h2', 'b1'));
    expect(await db.highlights.count()).toBe(2);

    await importBackup(blob, 'replace');
    expect((await db.highlights.toArray()).map((h) => h.id)).toEqual(['h1']);
  });

  it('merge keeps existing rows and adds the backup ones', async () => {
    await db.cards.put(card('c1', 'b1'));
    const blob = await exportBackup({ includeBooks: false });

    await db.cards.put(card('c2', 'b1'));
    await importBackup(blob, 'merge');

    expect((await db.cards.toArray()).map((c) => c.id).sort()).toEqual(['c1', 'c2']);
  });

  it('restores a book without its file as an empty blob and flags it', async () => {
    await db.books.put(book('b1'));
    const blob = await exportBackup({ includeBooks: true });

    await clearAll();
    const report = await importBackup(blob, 'replace');

    expect(report.missingFile).toEqual(['b1']);
    const restored = await db.books.get('b1');
    // fake-indexeddb stores Blobs as plain objects, so only presence is provable here.
    expect(restored).toHaveProperty('fileBlob');
    expect(restored?.title).toBe('Book b1');
  });
});

describe('importBackup: format compatibility', () => {
  it('restores a schema-1 zip that keeps all books in one data/books.json', async () => {
    const zip = await craftZip({
      'manifest.json': manifest(1),
      'data/books.json': strToU8(JSON.stringify([record(pdfBook())])),
      'data/highlights.json': strToU8(JSON.stringify([highlight('h1', 'b1')])),
      'books/b1.pdf': strToU8('%PDF-1.4'),
    });

    const report = await importBackup(zip, 'replace');

    expect(report.counts.books).toBe(1);
    expect(report.counts.highlights).toBe(1);
    // The book file matched its record: nothing is missing.
    expect(report.missingFile).toEqual([]);
    expect((await db.books.get('b1'))?.title).toBe('Basic & Clinical Pharmacology');
    expect(await db.highlights.get('h1')).toMatchObject({ bookId: 'b1' });
  });

  it('accepts a schema-1 zip whose books.json is pretty-printed', async () => {
    const zip = await craftZip({
      'manifest.json': manifest(1),
      'data/books.json': strToU8(JSON.stringify([record(book('b1'))], null, 2)),
    });
    await expect(importBackup(zip, 'merge')).resolves.toMatchObject({ counts: { books: 1 } });
  });

  it('restores a whole library written by v0.2.0 without losing a field', async () => {
    // Simulate the v0.2.0 device, then write its backup the way that version did.
    await seedLibrary();
    const before = await snapshot();
    const zip = await v02Zip({ 'books/b1.pdf': strToU8('%PDF-1.4 fake') });

    await clearAll();
    const report = await importBackup(zip, 'replace');

    expect(await snapshot()).toEqual(before);
    expect(report.mode).toBe('replace');
    expect(report.counts.books).toBe(2);
    // Only the book whose file the legacy export carried is whole.
    expect(report.missingFile).toEqual(['b2']);

    const restored = await db.books.get('b1');
    expect(restored?.parsed.chapters[0]?.blocks.map((block) => block.kind)).toEqual([...BLOCK_KINDS]);
    expect(restored?.lastPos).toEqual({ chapterId: 'ch1', sentenceId: 's-3' });
    expect(await getSetting('reader.lastPos.b1', null)).toEqual({ chapterId: 'ch1', sentenceId: 's-3' });
    expect(await db.cards.get('c1')).toMatchObject({ fsrs: { reps: 3 } });
    expect(await db.reviewLogs.get('r1')).toMatchObject({ log: { elapsed: 12_340 } });
  });

  it('accepts a schema-1 zip that also carries per-book entries', async () => {
    const zip = await craftZip({
      'manifest.json': manifest(1),
      'data/books.json': strToU8(JSON.stringify([record(book('b1'))], null, 2)),
      'data/books/b2.json': strToU8(JSON.stringify(record(book('b2')))),
      'books/b1.txt': strToU8('pharmacology text'),
      'books/b2.txt': strToU8('pharmacology text'),
    });

    const report = await importBackup(zip, 'replace');

    expect(report.counts.books).toBe(2);
    expect(report.missingFile).toEqual([]);
    expect((await db.books.toArray()).map((b) => b.id).sort()).toEqual(['b1', 'b2']);
  });

  it('rejects a zip that is not a PharmaReader backup', async () => {
    const other = await craftZip({ 'manifest.json': strToU8(JSON.stringify({ app: 'Other', schema: 1 })) });
    await expect(importBackup(other, 'merge')).rejects.toThrow(/not a PharmaReader backup/i);

    const newer = await craftZip({ 'manifest.json': manifest(BACKUP_SCHEMA + 1) });
    await expect(importBackup(newer, 'merge')).rejects.toThrow(/format 3/i);

    await expect(importBackup(await craftZip({}), 'merge')).rejects.toThrow(/manifest/i);
  });

  it('rejects records without an id', async () => {
    const zip = await craftZip({
      'manifest.json': manifest(),
      'data/cards.json': strToU8(JSON.stringify([{ front: 'no id here', back: 'x' }])),
    });
    await expect(importBackup(zip, 'merge')).rejects.toThrow(/cards/);
  });

  it('rejects the same book twice instead of letting one file win', async () => {
    const record1 = record(book('b1'));
    const zip = await craftZip({
      'manifest.json': manifest(),
      'data/books.json': strToU8(JSON.stringify([record1])),
      'data/books/b1.json': strToU8(JSON.stringify(record1)),
    });
    await expect(importBackup(zip, 'merge')).rejects.toThrow(/appears more than once/);
  });

  it('rejects a file that is not a zip at all', async () => {
    await expect(importBackup(new Blob(['not a zip']), 'merge')).rejects.toThrow(/valid zip/i);
  });
});

describe('privacy: AI settings never travel in a backup', () => {
  it('leaves every ai.* setting out of the export', async () => {
    await db.settings.bulkPut([
      { key: 'ai.apiKey', value: 'sk-secret' },
      { key: 'ai.baseUrl', value: 'https://api.attacker.example/v1' },
      { key: 'ai.model', value: 'exfil' },
      { key: 'ai.enabled', value: true },
      { key: 'theme', value: 'dark' },
    ]);

    const settings = readJson<{ key: string }[]>(await openZip(await exportBackup({ includeBooks: false })), 'data/settings.json');

    expect(settings.map((s) => s.key)).toEqual(['theme']);
    expect(JSON.stringify(settings)).not.toContain('attacker');
    expect(JSON.stringify(settings)).not.toContain('sk-secret');
  });

  it('strips crafted ai.* settings on import instead of repointing the key', async () => {
    await setSetting('ai.baseUrl', 'https://api.mine.example/v1');
    await setSetting('ai.apiKey', 'sk-mine');

    const zip = await craftZip({
      'manifest.json': manifest(),
      'data/settings.json': strToU8(
        JSON.stringify([
          { key: 'ai.baseUrl', value: 'https://api.attacker.example/v1' },
          { key: 'ai.apiKey', value: 'sk-attacker' },
          { key: 'ai.model', value: 'exfil' },
          { key: 'ai.enabled', value: true },
          { key: 'theme', value: 'dark' },
        ]),
      ),
    });
    await importBackup(zip, 'replace');

    expect(await getSetting('ai.baseUrl', '')).toBe('https://api.mine.example/v1');
    expect(await getSetting('ai.apiKey', '')).toBe('sk-mine');
    expect(await getSetting('ai.enabled', false)).toBe(false);
    expect(await getSetting('ai.model', 'mine')).toBe('mine');
    expect((await db.settings.toArray()).map((s) => s.key).sort()).toEqual(['ai.apiKey', 'ai.baseUrl', 'theme']);
  });
});

describe('import is a trust boundary', () => {
  it('rejects unknown tables instead of silently ignoring them', async () => {
    const zip = await craftZip({ 'manifest.json': manifest(), 'data/audioCache.json': strToU8('[]') });
    await expect(importBackup(zip, 'merge')).rejects.toThrow(/unknown table "audioCache"/);
  });

  it('rejects path traversal and unknown entries', async () => {
    const traversal = await craftZip({ 'manifest.json': manifest(), '../evil.txt': strToU8('x') });
    await expect(importBackup(traversal, 'merge')).rejects.toThrow(/not safe to import/i);

    const stray = await craftZip({ 'manifest.json': manifest(), 'notes.txt': strToU8('x') });
    await expect(importBackup(stray, 'merge')).rejects.toThrow(/not safe to import/i);

    const escape = await craftZip({ 'manifest.json': manifest(), 'data/books/../evil.json': strToU8('{}') });
    await expect(importBackup(escape, 'merge')).rejects.toThrow(/not safe to import/i);
  });

  it('rejects a book file that belongs to no book in the backup', async () => {
    const zip = await craftZip({
      'manifest.json': manifest(),
      'data/books.json': strToU8('[]'),
      'books/b9.txt': strToU8('orphan'),
    });
    await expect(importBackup(zip, 'merge')).rejects.toThrow(/does not belong to any book/i);
  });

  it('rejects a book file whose extension does not match the record', async () => {
    const zip = await craftZip({
      'manifest.json': manifest(),
      'data/books/b1.json': strToU8(JSON.stringify(record(book('b1')))),
      'books/b1.pdf': strToU8('%PDF'),
    });
    await expect(importBackup(zip, 'merge')).rejects.toThrow(/wrong type/i);
  });

  it('accepts a book file that matches its record', async () => {
    const zip = await craftZip({
      'manifest.json': manifest(),
      'data/books/b1.json': strToU8(JSON.stringify(record(book('b1')))),
      'books/b1.txt': strToU8('pharmacology text'),
    });

    const report = await importBackup(zip, 'merge');
    expect(report.missingFile).toEqual([]);
  });

  it('type-checks every field the app reads later', async () => {
    const zip = await craftZip({
      'manifest.json': manifest(),
      'data/highlights.json': strToU8(
        JSON.stringify([
          { id: 'h1', bookId: 'b1', sentenceIds: ['s1'], text: 'x', color: 'yellow', topicIds: [], createdAt: 'yesterday' },
        ]),
      ),
    });
    await expect(importBackup(zip, 'merge')).rejects.toThrow(/invalid "createdAt"/);

    const badColor = await craftZip({
      'manifest.json': manifest(),
      'data/highlights.json': strToU8(
        JSON.stringify([
          { id: 'h1', bookId: 'b1', sentenceIds: ['s1'], text: 'x', color: 'red', topicIds: [], createdAt: NOW },
        ]),
      ),
    });
    await expect(importBackup(badColor, 'merge')).rejects.toThrow(/invalid "color"/);
  });

  it('refuses a book record that is not an object', async () => {
    const zip = await craftZip({
      'manifest.json': manifest(),
      'data/books/b1.json': strToU8('[]'),
    });
    await expect(importBackup(zip, 'merge')).rejects.toThrow(/not a book record/);
  });

  it('refuses a book record filed under another id', async () => {
    const zip = await craftZip({
      'manifest.json': manifest(),
      'data/books/a.json': strToU8(JSON.stringify(record(book('b')))),
    });
    await expect(importBackup(zip, 'merge')).rejects.toThrow(/does not hold book "a"/);
  });

  it('type-checks the layout flag instead of writing an unknown value', async () => {
    const zip = await craftZip({
      'manifest.json': manifest(),
      'data/books/b1.json': strToU8(JSON.stringify({ ...record(book('b1')), layout: 'neural' })),
    });
    await expect(importBackup(zip, 'merge')).rejects.toThrow(/invalid "layout"/);
  });

  it('refuses an oversized zip without reading it', async () => {
    const huge = {
      size: 3 * 1024 ** 3,
      arrayBuffer: () => {
        throw new Error('the file must not be read');
      },
    } as unknown as Blob;
    await expect(importBackup(huge, 'merge')).rejects.toThrow(/too large/i);
  });
});

describe('replace is atomic', () => {
  it('leaves the database untouched when a write fails mid-import', async () => {
    await db.books.put(book('b1'));
    await db.highlights.put(highlight('h1', 'b1'));
    const blob = await exportBackup({ includeBooks: false });

    await clearAll();
    await db.books.put(book('local'));
    await db.highlights.put(highlight('h2', 'local'));

    // Books are written before highlights; this fails after the clears ran, so
    // the transaction must roll the clears and the book writes back.
    const boom = () => {
      throw new Error('disk full');
    };
    const hook = db.highlights.hook('creating');
    hook.subscribe(boom);
    try {
      await expect(importBackup(blob, 'replace')).rejects.toThrow(/disk full/);
    } finally {
      hook.unsubscribe(boom);
    }

    expect((await db.books.toArray()).map((b) => b.id)).toEqual(['local']);
    expect((await db.highlights.toArray()).map((h) => h.id)).toEqual(['h2']);
  });
});

describe('last backup label', () => {
  it('says never, today and N days ago', () => {
    expect(lastBackupLabel(undefined)).toBe('Last backup: never');
    expect(lastBackupLabel(0)).toBe('Last backup: never');
    expect(lastBackupLabel(NOW, NOW + 60_000)).toBe('Last backup: today');
    expect(lastBackupLabel(NOW, NOW + 3 * 24 * 60 * 60 * 1000)).toBe('Last backup: 3 days ago');
    expect(lastBackupLabel(NOW, NOW + 24 * 60 * 60 * 1000)).toBe('Last backup: 1 day ago');
  });

  it('names the setting the panel writes', () => {
    expect(LAST_EXPORT_SETTING).toBe('backup.lastExportAt');
  });
});

describe('export streams book files', () => {
  it('copies the bytes of each book, including empty ones', async () => {
    const text = 'Aspirin irreversibly inhibits COX-1.';
    const spy = vi.spyOn(db.books, 'toArray');
    spy.mockResolvedValue([
      { ...book('b1'), fileBlob: new Blob([strToU8(text)]) },
      { ...book('b0'), fileBlob: new Blob([]) },
    ] as never);

    const files = await openZip(await exportBackup({ includeBooks: true }));

    expect(strFromU8(files['books/b1.txt'])).toBe(text);
    expect(files['books/b0.txt']).toHaveLength(0);
  });
});

describe('a notes-only backup never drops a local book file', () => {
  it('keeps the file of a book already on the device on a replace import', async () => {
    const local = new Blob(['%PDF local file']);
    const zip = await craftZip({
      'manifest.json': manifest(),
      'data/books.json': strToU8(JSON.stringify([{ ...book('b1'), fileBlob: undefined }])),
    });
    // fake-indexeddb cannot hold a real Blob, so hand the stored record back directly.
    vi.spyOn(db.books, 'get').mockResolvedValue({ ...book('b1'), fileBlob: local } as never);

    const report = await importBackup(zip, 'replace');

    // Reported missing (and written as an empty Blob) only when the local file was not reused.
    expect(report.missingFile).toEqual([]);
  });
});
