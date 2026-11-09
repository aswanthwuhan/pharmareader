/**
 * Full-device backup: every IndexedDB table as JSON plus, optionally, the
 * original book files. One zip, imported back on this or another device.
 */
import { strFromU8, strToU8, unzip, zip, type AsyncZippable, type Unzipped } from 'fflate';
import { db } from '../core/db';
import type { BookRecord, DocFormat, Setting } from '../core/types';

export const BACKUP_APP = 'PharmaReader';
export const BACKUP_SCHEMA = 1;

/** Never exported: it is a credential, and the zip may leave the device. */
export const EXCLUDED_SETTING = 'ai.apiKey';

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

/** Every table except the audio cache, which is rebuildable and huge. */
function dataTables() {
  return db.tables.filter((t) => t.name !== 'audioCache');
}

export function backupFileName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `pharmareader-backup-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.zip`;
}

export async function exportBackup({ includeBooks }: { includeBooks: boolean }): Promise<Blob> {
  const files: AsyncZippable = {};
  const counts: Record<string, number> = {};

  for (const table of dataTables()) {
    let rows: unknown[] = await table.toArray();
    // Blobs do not belong in the JSON: books travel as raw files instead.
    if (table.name === 'books') rows = rows.map(stripFileBlob);
    if (table.name === 'settings') rows = rows.filter((row) => (row as Setting).key !== EXCLUDED_SETTING);
    counts[table.name] = rows.length;
    files[`data/${table.name}.json`] = strToU8(JSON.stringify(rows, null, 2));
  }

  if (includeBooks) {
    for (const book of await db.books.toArray()) {
      // fake-indexeddb (tests) hands blobs back as plain objects.
      if (!(book.fileBlob instanceof Blob)) continue;
      const bytes = new Uint8Array(await book.fileBlob.arrayBuffer());
      // Already-compressed formats gain nothing from deflate.
      files[`books/${book.id}.${book.format}`] = [bytes, { level: 0 }];
    }
  }

  const manifest: BackupManifest = {
    app: BACKUP_APP,
    schema: BACKUP_SCHEMA,
    exportedAt: new Date().toISOString(),
    counts,
  };
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));

  return new Blob([await zipAsync(files)], { type: 'application/zip' });
}

export async function importBackup(file: Blob, mode: ImportMode): Promise<ImportReport> {
  const files = await unzipAsync(new Uint8Array(await file.arrayBuffer()));
  readManifest(files);

  const tables = dataTables();
  const payload = new Map<string, unknown[]>();
  for (const table of tables) {
    const rows = readTable(files, table.name);
    if (!rows) continue;
    for (const row of rows) requireKey(row, table.name);
    payload.set(table.name, table.name === 'settings' ? rows.filter((r) => (r as Setting).key !== EXCLUDED_SETTING) : rows);
  }

  const counts: Record<string, number> = {};
  const missingFile: string[] = [];

  await db.transaction('rw', tables, async () => {
    if (mode === 'replace') {
      // Settings survive on purpose: they hold this device's provider config and
      // API key, which the export omits — wiping them would lock the user out.
      for (const table of tables) if (table.name !== 'settings') await table.clear();
    }
    for (const table of tables) {
      const rows = payload.get(table.name);
      if (!rows || rows.length === 0) continue;
      const prepared =
        table.name === 'books' ? await restoreBooks(rows, files, mode, missingFile) : rows;
      await table.bulkPut(prepared);
      counts[table.name] = prepared.length;
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
async function restoreBooks(
  rows: unknown[],
  files: Unzipped,
  mode: ImportMode,
  missing: string[],
): Promise<BookRecord[]> {
  const books: BookRecord[] = [];
  for (const row of rows) {
    const record = row as Omit<BookRecord, 'fileBlob'>;
    const bytes = files[`books/${record.id}.${record.format}`];
    let fileBlob: Blob;
    if (bytes) {
      fileBlob = new Blob([bytes], { type: MIME[record.format] ?? 'application/octet-stream' });
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

function readManifest(files: Unzipped): BackupManifest {
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
  return {
    app: BACKUP_APP,
    schema: BACKUP_SCHEMA,
    exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : '',
    counts: parsed.counts ?? {},
  };
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

/** Every row must be addressable, or merging would lose or overwrite data. */
function requireKey(row: unknown, table: string): void {
  const r = (row && typeof row === 'object' ? row : {}) as { id?: unknown; key?: unknown };
  const key = typeof r.id === 'string' && r.id ? r.id : typeof r.key === 'string' && r.key ? r.key : '';
  if (!key) throw new Error(`This backup is damaged: a "${table}" record has no id.`);
}

function zipAsync(files: AsyncZippable): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    zip(files, { level: 6 }, (err, data) =>
      err ? reject(new Error(`Could not build the backup zip: ${err.message}`)) : resolve(data),
    );
  });
}

async function unzipAsync(bytes: Uint8Array): Promise<Unzipped> {
  return new Promise((resolve, reject) => {
    unzip(bytes, (err, data) =>
      err ? reject(new Error('That file is not a valid zip archive.')) : resolve(data),
    );
  });
}
