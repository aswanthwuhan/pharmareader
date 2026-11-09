import { strFromU8, strToU8, unzipSync, zipSync, type Unzipped } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../core/db';
import { getSetting, setSetting } from '../core/settings';
import type { BookRecord, CardRecord, Highlight } from '../core/types';
import {
  BACKUP_APP,
  BACKUP_SCHEMA,
  backupFileName,
  exportBackup,
  importBackup,
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

async function clearAll(): Promise<void> {
  for (const table of db.tables) await table.clear();
}

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of db.tables) out[table.name] = await table.count();
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

const manifest = () => strToU8(JSON.stringify({ app: BACKUP_APP, schema: BACKUP_SCHEMA }));

beforeEach(async () => {
  await clearAll();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('exportBackup', () => {
  it('writes a manifest and one JSON file per table, without the API key or blobs', async () => {
    await db.books.put(book('b1'));
    await db.highlights.put(highlight('h1', 'b1'));
    await db.cards.put(card('c1', 'b1'));
    await db.settings.put({ key: 'ai.apiKey', value: 'sk-secret' });
    await db.settings.put({ key: 'theme', value: 'dark' });
    await db.audioCache.put({ key: 'a1', engine: 'system', audio: new Blob(['x']), durationMs: 1, createdAt: NOW });

    const files = await openZip(await exportBackup({ includeBooks: false }));

    const manifest = readJson<BackupManifest>(files, 'manifest.json');
    expect(manifest.app).toBe(BACKUP_APP);
    expect(manifest.schema).toBe(BACKUP_SCHEMA);
    expect(manifest.counts.books).toBe(1);
    expect(manifest.counts.cards).toBe(1);
    expect(Date.parse(manifest.exportedAt)).toBeGreaterThan(0);

    const settings = readJson<{ key: string }[]>(files, 'data/settings.json');
    expect(settings.map((s) => s.key)).toEqual(['theme']);
    expect(JSON.stringify(settings)).not.toContain('sk-secret');

    const books = readJson<Record<string, unknown>[]>(files, 'data/books.json');
    expect(books[0]).not.toHaveProperty('fileBlob');
    expect(books[0].title).toBe('Book b1');

    expect(files['data/audioCache.json']).toBeUndefined();
  });

  it('names the file after the export date', () => {
    expect(backupFileName(new Date(2026, 0, 9))).toBe('pharmareader-backup-2026-01-09.zip');
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

describe('importBackup', () => {
  it('round-trips a replace: every table comes back with the same counts', async () => {
    await db.books.put(book('b1'));
    await db.highlights.bulkPut([highlight('h1', 'b1'), highlight('h2', 'b1')]);
    await db.bookmarks.put({ id: 'm1', bookId: 'b1', chapterId: 'c1', sentenceId: 's1', createdAt: NOW });
    await db.cards.put(card('c1', 'b1'));
    await db.reviewLogs.put({ id: 'r1', cardId: 'c1', rating: 3, reviewedAt: NOW, log: {} });
    await db.topics.put({ id: 't1', parentId: null, title: 'General pharmacology', level: 'basic', order: 1 });
    await db.lexicon.put({
      id: 'l1',
      pattern: 't½',
      replacement: 'half-life',
      isRegex: false,
      source: 'user',
      enabled: true,
    });
    await db.settings.put({ key: 'ai.apiKey', value: 'sk-secret' });
    await db.settings.put({ key: 'theme', value: 'dark' });

    const before = await counts();
    const blob = await exportBackup({ includeBooks: false });

    await clearAll();
    // The device keeps its own key across a restore; the backup never had it.
    await setSetting('ai.apiKey', 'sk-secret');

    const report = await importBackup(blob, 'replace');

    expect(await counts()).toEqual(before);
    expect(report.mode).toBe('replace');
    expect(report.counts.books).toBe(1);
    expect(report.counts.highlights).toBe(2);
    // A notes-and-cards backup carries no book files; the records still restore.
    expect(report.missingFile).toEqual(['b1']);
    expect(await getSetting('ai.apiKey', '')).toBe('sk-secret');
    expect(await getSetting('theme', 'light')).toBe('dark');
  });

  it('replace drops rows that are not in the backup', async () => {
    await db.highlights.put(highlight('h1', 'b1'));
    const blob = await exportBackup({ includeBooks: false });

    await db.highlights.put(highlight('h2', 'b1'));
    expect(await db.highlights.count()).toBe(2);

    await importBackup(blob, 'replace');
    expect((await db.highlights.toArray()).map((h) => h.id)).toEqual(['h1']);
  });

  it('merge keeps existing rows', async () => {
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

  it('rejects a zip that is not a PharmaReader backup', async () => {
    const other = await craftZip({ 'manifest.json': strToU8(JSON.stringify({ app: 'Other', schema: 1 })) });
    await expect(importBackup(other, 'merge')).rejects.toThrow(/not a PharmaReader backup/i);

    const newer = await craftZip({
      'manifest.json': strToU8(JSON.stringify({ app: BACKUP_APP, schema: BACKUP_SCHEMA + 1 })),
    });
    await expect(importBackup(newer, 'merge')).rejects.toThrow(/format 2/i);

    await expect(importBackup(await craftZip({}), 'merge')).rejects.toThrow(/manifest/i);
  });

  it('rejects records without an id', async () => {
    const zip = await craftZip({
      'manifest.json': strToU8(JSON.stringify({ app: BACKUP_APP, schema: BACKUP_SCHEMA })),
      'data/cards.json': strToU8(JSON.stringify([{ front: 'no id here', back: 'x' }])),
    });
    await expect(importBackup(zip, 'merge')).rejects.toThrow(/cards/);
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
    const record = { ...book('b1') } as Record<string, unknown>;
    delete record.fileBlob;
    const zip = await craftZip({
      'manifest.json': manifest(),
      'data/books.json': strToU8(JSON.stringify([record])),
      'books/b1.pdf': strToU8('%PDF'),
    });
    await expect(importBackup(zip, 'merge')).rejects.toThrow(/wrong type/i);
  });

  it('accepts a book file that matches its record', async () => {
    const record = { ...book('b1') } as Record<string, unknown>;
    delete record.fileBlob;
    const zip = await craftZip({
      'manifest.json': manifest(),
      'data/books.json': strToU8(JSON.stringify([record])),
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
