import { useState } from 'react';
import { backupFileName, exportBackup, importBackup, type ImportMode, type ImportReport } from './backup';
import './backup.css';

const TABLE_LABEL: Record<string, readonly [string, string]> = {
  books: ['book', 'books'],
  highlights: ['highlight', 'highlights'],
  bookmarks: ['bookmark', 'bookmarks'],
  cards: ['card', 'cards'],
  reviewLogs: ['review', 'reviews'],
  topics: ['topic', 'topics'],
  lexicon: ['pronunciation', 'pronunciations'],
  settings: ['setting', 'settings'],
};

function label(table: string, n: number): string {
  const pair = TABLE_LABEL[table];
  if (!pair) return table;
  return n === 1 ? pair[0] : pair[1];
}

/** Backup panel for the Settings page: one card out, one card back in. */
export default function BackupPanel() {
  const [busy, setBusy] = useState<'books' | 'data' | 'import' | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<ImportMode>('merge');
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  async function runExport(includeBooks: boolean) {
    setBusy(includeBooks ? 'books' : 'data');
    setStatus(null);
    try {
      const blob = await exportBackup({ includeBooks });
      const name = backupFileName();
      download(blob, name);
      setStatus({ ok: true, text: `Exported ${name} (${megabytes(blob.size)}).` });
    } catch (err) {
      setStatus({ ok: false, text: message(err) });
    } finally {
      setBusy(null);
    }
  }

  async function runImport() {
    if (!file) return;
    if (
      mode === 'replace' &&
      !window.confirm(
        'Replace all books, highlights, bookmarks, cards, reviews, topics, pronunciations and settings on this device ' +
          'with the backup? This cannot be undone.',
      )
    ) {
      return;
    }
    setBusy('import');
    setStatus(null);
    try {
      setStatus({ ok: true, text: describe(await importBackup(file, mode)) });
    } catch (err) {
      setStatus({ ok: false, text: message(err) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="backup-panel">
      <div className="card backup-card">
        <h3 className="card-title">Export</h3>
        <p className="card-body">
          Everything stays on this device until you export. The audio cache is left out — it is rebuilt when you listen
          again. AI settings and your API key are never written into a backup.
        </p>
        <div className="backup-actions">
          <button type="button" className="btn btn-primary" onClick={() => void runExport(true)} disabled={busy !== null}>
            {busy === 'books' ? 'Exporting…' : 'Export (with books)'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => void runExport(false)} disabled={busy !== null}>
            {busy === 'data' ? 'Exporting…' : 'Export (notes & cards only)'}
          </button>
        </div>
        <p className="field-hint">A .zip file with your books and study data, saved wherever your browser downloads.</p>
      </div>

      <div className="card backup-card">
        <h3 className="card-title">Import</h3>
        <p className="card-body">Restores a backup made with PharmaReader, on this device or another one.</p>

        <div className="field">
          <label className="field-label" htmlFor="backup-file">
            Backup file
          </label>
          <input
            id="backup-file"
            className="backup-file"
            type="file"
            accept=".zip,application/zip"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={busy !== null}
          />
        </div>

        <div className="backup-mode" role="radiogroup" aria-labelledby="backup-mode-label">
          <p id="backup-mode-label" className="field-label">
            Import mode
          </p>
          <label className="backup-radio">
            <input
              id="backup-merge"
              type="radio"
              name="backup-mode"
              checked={mode === 'merge'}
              onChange={() => setMode('merge')}
            />
            <span>
              <span className="backup-radio-label">Merge</span> — add to what is already here
            </span>
          </label>
          <label className="backup-radio">
            <input
              id="backup-replace"
              type="radio"
              name="backup-mode"
              checked={mode === 'replace'}
              onChange={() => setMode('replace')}
            />
            <span>
              <span className="backup-radio-label">Replace</span> — delete local books, highlights, cards, reviews,
              topics, pronunciations and settings first
            </span>
          </label>
        </div>

        {mode === 'replace' ? (
          <div className="banner banner-warning" role="alert">
            <p>
              Importing will delete the books, highlights, bookmarks, cards, reviews, topics, pronunciations and settings
              already on this device before restoring the backup. This cannot be undone.
            </p>
          </div>
        ) : null}

        <div className="backup-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void runImport()}
            disabled={!file || busy !== null}
          >
            {busy === 'import' ? 'Importing…' : 'Import backup'}
          </button>
        </div>
      </div>

      {status ? (
        <div className={status.ok ? 'banner banner-success' : 'banner banner-error'} role={status.ok ? 'status' : 'alert'}>
          <p>{status.text}</p>
        </div>
      ) : null}
    </div>
  );
}

function describe(report: ImportReport): string {
  const parts = Object.entries(report.counts).map(([table, n]) => `${n} ${label(table, n)}`);
  const head = parts.length ? `Imported ${parts.join(', ')}.` : 'The backup had no records.';
  const missing = report.missingFile.length
    ? ` ${report.missingFile.length} book file${report.missingFile.length === 1 ? ' was' : 's were'} not in the zip — re-import those books to read them.`
    : '';
  return head + missing;
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function megabytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
