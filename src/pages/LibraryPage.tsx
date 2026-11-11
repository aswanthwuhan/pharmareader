import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { db } from '../core/db';
import { pushBackHandler } from '../core/backButton';
import { setSetting, useSetting } from '../core/settings';
import type { BookRecord, ColumnMode } from '../core/types';
import { checkForUpdate, dismissUpdate, type UpdateRelease } from '../core/updateCheck';
import { APP_VERSION } from '../core/version';
import { deleteBook, importFileDetailed, importText, importUrl, setBookColumns } from '../import';
import '../import/library.css';
import { LAST_BOOK_KEY, type LastBook } from '../reader/lastBook';
import ModelStatusBanner from '../tts/ModelStatusBanner';

const ACCEPT = '.pdf,.epub,.docx,.txt,.md,.html';

/** Written by the backup worker after a successful export. */
const BACKUP_KEY = 'backup.lastExportAt';
/** Set when the reader dismisses the reminder, so it stays quiet for a week. */
const BACKUP_DISMISS_KEY = 'backup.reminderDismissedAt';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const FORMAT_LABEL: Record<BookRecord['format'], string> = {
  pdf: 'PDF',
  epub: 'EPUB',
  docx: 'DOCX',
  txt: 'TXT',
  md: 'MD',
  html: 'HTML',
};

/** A PDF's column choice, in the order the sheet offers it. */
const COLUMN_OPTIONS: { value: ColumnMode; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 1, label: 'One column' },
  { value: 2, label: 'Two columns' },
];

/** An import note, split so the banner can lead with the file it belongs to. */
type Warning = { file: string; message: string; scanned: boolean };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readingProgress(book: BookRecord): number | null {
  const position = book.lastPos;
  if (!position) return null;

  let total = 0;
  for (const chapter of book.parsed.chapters) {
    for (const block of chapter.blocks) total += block.sentences.length;
  }
  if (!total) return 0;

  let seen = 0;
  for (const chapter of book.parsed.chapters) {
    if (chapter.id !== position.chapterId) {
      for (const block of chapter.blocks) seen += block.sentences.length;
      continue;
    }
    for (const block of chapter.blocks) {
      for (const sentence of block.sentences) {
        seen += 1;
        if (sentence.id === position.sentenceId) return Math.round((seen / total) * 100);
      }
    }
    break;
  }
  return Math.round((seen / total) * 100);
}

function chapterCount(book: BookRecord): number {
  return book.parsed.chapters.length;
}

/* --- Icons -----------------------------------------------------------------
   Inline SVG, one drawing hand: 24px grid, 1.7 stroke, round joins, currentColor.
   -------------------------------------------------------------------------- */
function WarningIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3.8 2.7 19.4h18.6L12 3.8Z" />
      <path d="M12 9.6v4.2" />
      <path d="M12 16.6h.01" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="5.6" r="1.1" />
      <circle cx="12" cy="12" r="1.1" />
      <circle cx="12" cy="18.4" r="1.1" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.6 14.4 14.4 9.6" />
      <path d="M12.9 7.1l1-1a3.6 3.6 0 0 1 5.1 5.1l-1.4 1.4" />
      <path d="M11.1 16.9l-1 1a3.6 3.6 0 0 1-5.1-5.1l1.4-1.4" />
    </svg>
  );
}

function ClipboardIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 4.6h6v2.6H9z" />
      <path d="M9 6H7.2A1.7 1.7 0 0 0 5.5 7.7v11A1.7 1.7 0 0 0 7.2 20.4h9.6a1.7 1.7 0 0 0 1.7-1.7v-11A1.7 1.7 0 0 0 16.8 6H15" />
      <path d="M8.8 11.6h6.4M8.8 15.2h4.2" />
    </svg>
  );
}

function ShelfMark() {
  return (
    <svg className="empty-state-mark" viewBox="0 0 48 48" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M24 13.5c-3.2-2.9-7.4-4.3-11.8-4.3H6.5v25.6h5.7c4.4 0 8.6 1.4 11.8 4.3 3.2-2.9 7.4-4.3 11.8-4.3h5.7V9.2h-5.7c-4.4 0-8.6 1.4-11.8 4.3Z" />
      <path d="M24 13.5v25.6" />
      <path d="M14.5 18.5h4M14.5 24h4" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </svg>
  );
}

/**
 * The row's "more" sheet, which is also the delete confirmation: a row menu
 * that opened a second dialog would be two sheets for one decision.
 *
 * A PDF also gets its column layout here. Pages whose two columns read out of
 * order are re-read with the reader's pick, without leaving the library.
 */
function BookActionsSheet({
  book,
  onCancel,
  onDelete,
}: {
  book: BookRecord;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const titleId = useId();
  const descId = useId();
  const columnsId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const columnsRef = useRef<HTMLSelectElement>(null);
  // The stored choice, mirrored here so the control follows the pick while the
  // book is re-read; the book row itself is a stale copy from the library list.
  const [columns, setColumns] = useState<ColumnMode>(book.columns ?? 'auto');
  const [columnsBusy, setColumnsBusy] = useState(false);
  const [columnsNote, setColumnsNote] = useState<string | null>(null);
  const [columnsError, setColumnsError] = useState<string | null>(null);
  // Mount-only effect: the latest callbacks, without re-running focus on every render.
  // While the book is being re-read the sheet stays open, so a failure is still
  // on screen to be read instead of reported to a sheet that has gone.
  const busyRef = useRef(false);
  busyRef.current = columnsBusy;
  const close = () => {
    if (!busyRef.current) onCancel();
  };
  const cancelRefFn = useRef(close);
  cancelRefFn.current = close;

  useEffect(() => {
    cancelRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        cancelRefFn.current();
        return;
      }
      // Tab and Shift+Tab wrap inside the sheet instead of walking into the page
      // behind it; the column control, when the book is a PDF, is the first stop.
      if (event.key !== 'Tab') return;
      const first = columnsRef.current ?? cancelRef.current;
      const last = deleteRef.current;
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    // Same one-line hook as the import panels: Android back closes the sheet
    // instead of leaving the library under it.
    const dispose = pushBackHandler(() => {
      cancelRefFn.current();
      return true;
    });
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      dispose();
    };
  }, []);

  async function changeColumns(value: string): Promise<void> {
    const next: ColumnMode = value === '2' ? 2 : value === '1' ? 1 : 'auto';
    if (next === columns) return;
    const previous = columns;
    setColumns(next);
    setColumnsBusy(true);
    setColumnsNote(null);
    setColumnsError(null);
    try {
      await setBookColumns(book.id, next, (note) => setColumnsNote(note));
    } catch (error) {
      // Nothing was written: the book still has the layout it was read with.
      setColumns(previous);
      setColumnsError(errorMessage(error));
    } finally {
      setColumnsBusy(false);
      setColumnsNote(null);
    }
  }

  return (
    <>
      <div className="sheet-backdrop" onClick={close} />
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId}>
        <h2 id={titleId} className="sheet-title lib-sheet-title">
          {book.title}
        </h2>
        {book.format === 'pdf' && (
          <div className="field lib-columns">
            <label className="field-label" htmlFor={columnsId}>
              Columns
            </label>
            <select
              ref={columnsRef}
              id={columnsId}
              className="input"
              value={columns}
              disabled={columnsBusy}
              onChange={(event) => void changeColumns(event.target.value)}
            >
              {COLUMN_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="field-hint">
              Use Two if the voice jumps between columns; One for single-column books.
            </span>
            {columnsBusy && (
              <span className="lib-columns-note" role="status" aria-live="polite">
                <span className="lib-spinner" aria-hidden="true" />
                {columnsNote ? `Reading the book again — ${columnsNote}…` : 'Reading the book again…'}
              </span>
            )}
            {columnsError && (
              <span className="lib-columns-error" role="alert">
                Could not change the columns: {columnsError}
              </span>
            )}
          </div>
        )}
        {/* The warning describes Delete book, so it sits directly above the two
            actions — the column setting above it is not about deleting. */}
        <p className="muted" id={descId}>
          Its highlights, bookmarks and cards go with it.
        </p>
        <div className="sheet-actions">
          <button ref={cancelRef} type="button" className="btn btn-secondary" onClick={close} disabled={columnsBusy}>
            Cancel
          </button>
          <button ref={deleteRef} type="button" className="btn btn-danger" onClick={onDelete}>
            Delete book
          </button>
        </div>
      </div>
    </>
  );
}

export default function LibraryPage() {
  const navigate = useNavigate();

  // No default value: `undefined` means the first IndexedDB read is still in
  // flight, which the page shows as a loading state instead of "empty shelf".
  const books = useLiveQuery(() => db.books.orderBy('addedAt').reverse().toArray(), []);

  // Walking every sentence of every book is not free, and the page re-renders on
  // each keystroke in the URL field: do it once per library change, not per render.
  const progressById = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const book of books ?? []) map.set(book.id, readingProgress(book));
    return map;
  }, [books]);

  const fileInput = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const [panel, setPanel] = useState<'none' | 'web' | 'text'>('none');
  // The row whose "more" sheet is open, plus the button that opened it so focus
  // can come back to the same row when the sheet closes.
  const [menuBook, setMenuBook] = useState<BookRecord | null>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const [url, setUrl] = useState('');
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteText, setPasteText] = useState('');

  const busy = status !== null;
  const loading = books === undefined;
  const shelf = books ?? [];

  // The Android back key closes an open import panel before it can mean
  // "leave the library": a half-typed URL or pasted chapter is not lost by
  // one stray press.
  useEffect(() => {
    if (panel === 'none') return;
    return pushBackHandler(() => {
      setPanel('none');
      return true;
    });
  }, [panel]);

  // "Continue listening": the last book opened in the reader, offered in one
  // tap instead of making her find the row again.
  const lastBook = useSetting<LastBook | undefined>(LAST_BOOK_KEY, undefined);
  const continueBook = lastBook ? shelf.find((book) => book.id === lastBook.bookId) : undefined;

  // Notes and cards live only on this phone; a week without an export is worth
  // one quiet reminder, and a dismissal buys another quiet week.
  const now = Date.now();
  const lastExportAt = useSetting<number | undefined>(BACKUP_KEY, undefined);
  const backupDismissedAt = useSetting<number | undefined>(BACKUP_DISMISS_KEY, undefined);
  const backupStale = lastExportAt === undefined || now - lastExportAt > WEEK_MS;
  const backupQuiet = backupDismissedAt !== undefined && now - backupDismissedAt < WEEK_MS;
  const showBackupReminder = shelf.length > 0 && backupStale && !backupQuiet;

  function dismissBackupReminder(): void {
    void setSetting(BACKUP_DISMISS_KEY, Date.now()).catch(() => {});
  }

  // New version, if the reader asked for update checks. Deferred so it can never
  // hold up the shelf, and silent on every failure: checkForUpdate resolves null.
  const [update, setUpdate] = useState<UpdateRelease | null>(null);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void checkForUpdate()
        .then((release) => {
          if (!cancelled && release) setUpdate(release);
        })
        .catch(() => undefined);
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  function notNow(): void {
    if (!update) return;
    void dismissUpdate(update.version).catch(() => {});
    setUpdate(null);
  }

  async function handleFiles(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (!files.length || busy) return;

    setErrors([]);
    setWarnings([]);

    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      const prefix = files.length > 1 ? `Importing ${index + 1} of ${files.length}: ${file.name}` : `Importing ${file.name}`;
      setStatus(`${prefix}…`);
      try {
        const result = await importFileDetailed(file, (note) => setStatus(`${prefix} — ${note}…`));
        const warning = result.warning;
        if (warning) {
          setWarnings((current) => [
            ...current,
            { file: file.name, message: warning, scanned: warning.startsWith('Looks scanned') },
          ]);
        }
        if (files.length === 1 && !warning) navigate(`/read/${result.bookId}`);
      } catch (error) {
        setErrors((current) => [...current, `${file.name}: ${errorMessage(error)}`]);
      }
    }

    setStatus(null);
    if (fileInput.current) fileInput.current.value = '';
  }

  async function handleUrl(event: FormEvent) {
    event.preventDefault();
    if (!url.trim() || busy) return;
    setErrors([]);
    setWarnings([]);
    setStatus('Fetching the article…');
    try {
      const bookId = await importUrl(url);
      setUrl('');
      navigate(`/read/${bookId}`);
    } catch (error) {
      setErrors([errorMessage(error)]);
    } finally {
      setStatus(null);
    }
  }

  async function handleText(event: FormEvent) {
    event.preventDefault();
    if (!pasteText.trim() || busy) return;
    setErrors([]);
    setWarnings([]);
    setStatus('Saving the text…');
    try {
      const bookId = await importText(pasteTitle, pasteText);
      setPasteTitle('');
      setPasteText('');
      navigate(`/read/${bookId}`);
    } catch (error) {
      setErrors([errorMessage(error)]);
    } finally {
      setStatus(null);
    }
  }

  async function handleDelete(book: BookRecord) {
    try {
      await deleteBook(book.id);
      // The row and its More button are gone, so returning focus there would
      // land on <body>. Start again from the page heading instead.
      titleRef.current?.focus();
    } catch (error) {
      setErrors([`Could not delete “${book.title}”: ${errorMessage(error)}`]);
    }
  }

  function openBookMenu(book: BookRecord, trigger: HTMLButtonElement): void {
    menuTrigger.current = trigger;
    setMenuBook(book);
  }

  function closeBookMenu(): void {
    setMenuBook(null);
    menuTrigger.current?.focus();
  }

  const countSub = loading
    ? 'Loading…'
    : shelf.length === 0
      ? 'Stored on this device only'
      : `${shelf.length} ${shelf.length === 1 ? 'book' : 'books'} · stored on this device`;

  return (
    <section className="page library">
      <header className="app-bar">
        <div>
          <h1 ref={titleRef} tabIndex={-1}>
            Library
          </h1>
          <p className="app-bar-sub">{countSub}</p>
        </div>
        <div className="app-bar-actions">
          <button
            type="button"
            className={continueBook ? 'btn btn-secondary' : 'btn btn-primary'}
            onClick={() => fileInput.current?.click()}
            disabled={busy}
          >
            Import
          </button>
          <input
            ref={fileInput}
            className="visually-hidden"
            type="file"
            accept={ACCEPT}
            multiple
            tabIndex={-1}
            onChange={(event) => void handleFiles(event.target.files)}
          />
        </div>
      </header>
      <ModelStatusBanner context="library" />

      {update ? (
        <div className="banner banner-info lib-update">
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            focusable="false"
          >
            <path d="M12 4.5v10" />
            <path d="M8 10.8 12 15l4-4.2" />
            <path d="M5 19.5h14" />
          </svg>
          <div className="lib-update-body">
            <p className="banner-title">PharmaReader {update.version} is available</p>
            <p>You are on {APP_VERSION}. The new version installs over this one and keeps your books.</p>
          </div>
          <div className="lib-update-actions">
            <a className="btn btn-secondary" href={update.url} target="_blank" rel="noopener noreferrer">
              Download
            </a>
            <button type="button" className="btn btn-ghost" onClick={notNow}>
              Not now
            </button>
          </div>
        </div>
      ) : null}

      <div className="toolbar lib-actions">
        <button
          type="button"
          className="btn btn-ghost"
          aria-expanded={panel === 'web'}
          aria-controls="lib-web-panel"
          onClick={() => setPanel(panel === 'web' ? 'none' : 'web')}
          disabled={busy}
        >
          <LinkIcon />
          Add from web
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          aria-expanded={panel === 'text'}
          aria-controls="lib-text-panel"
          onClick={() => setPanel(panel === 'text' ? 'none' : 'text')}
          disabled={busy}
        >
          <ClipboardIcon />
          Paste text
        </button>
      </div>

      {panel === 'web' && (
        <form id="lib-web-panel" className="card lib-panel" onSubmit={(event) => void handleUrl(event)}>
          <label className="field">
            <span className="field-label">Article address</span>
            <input
              className="input"
              type="url"
              inputMode="url"
              autoComplete="url"
              placeholder="https://…"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              required
            />
          </label>
          <div className="lib-panel-actions">
            <button type="submit" className="btn btn-primary" disabled={busy || !url.trim()}>
              Import article
            </button>
          </div>
          <p className="field-hint">Some sites block browser fetches. If the import fails, use “Paste text”.</p>
        </form>
      )}

      {panel === 'text' && (
        <form id="lib-text-panel" className="card lib-panel" onSubmit={(event) => void handleText(event)}>
          <label className="field">
            <span className="field-label">Title</span>
            <input
              className="input"
              type="text"
              placeholder="Optional — first line if empty"
              value={pasteTitle}
              onChange={(event) => setPasteTitle(event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">Text</span>
            <textarea
              className="input"
              rows={8}
              placeholder="Paste an article, a chapter or your own notes…"
              value={pasteText}
              onChange={(event) => setPasteText(event.target.value)}
              required
            />
          </label>
          <div className="lib-panel-actions">
            <button type="submit" className="btn btn-primary" disabled={busy || !pasteText.trim()}>
              Save text
            </button>
          </div>
        </form>
      )}

      {status && (
        <p className="lib-status" role="status">
          <span className="lib-spinner" aria-hidden="true" />
          <span>{status}</span>
        </p>
      )}

      {errors.map((message, index) => (
        <div className="banner banner-error" role="alert" key={`${index}-${message}`}>
          <WarningIcon />
          <div>
            <p className="banner-title">Could not import</p>
            <p>{message}</p>
          </div>
        </div>
      ))}

      {warnings.map((warning) => (
        <div className="banner banner-warning" role="status" key={`${warning.file}-${warning.message}`}>
          <WarningIcon />
          <div>
            <p className="banner-title">{warning.scanned ? 'Looks scanned' : 'Imported with a note'}</p>
            <p>
              {warning.scanned ? (
                <>
                  <strong>{warning.file}</strong> has no text layer, so there is nothing to read, search or listen to
                  in it yet.
                </>
              ) : (
                <>
                  <strong>{warning.file}</strong>: {warning.message}
                </>
              )}
            </p>
            {warning.scanned && (
              <p className="lib-banner-hint">
                Try a text-based PDF, or use “Paste text” for the pages you need. OCR is not supported yet.
              </p>
            )}
          </div>
        </div>
      ))}

      {!loading && continueBook ? (
        <p className="lib-continue">
          <Link className="btn btn-primary lib-continue-btn" to={`/read/${continueBook.id}?play=1`}>
            Continue: <span className="lib-continue-title">{continueBook.title}</span>
          </Link>
        </p>
      ) : null}

      {showBackupReminder ? (
        <div className="banner banner-info lib-backup">
          <div className="lib-backup-body">
            <p className="banner-title">
              <Link to="/settings#backup">Back up your notes and cards</Link>
            </p>
            <p>
              Highlights, cards and reading positions live on this phone only. An export is the copy that survives a
              lost or reset phone.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon lib-backup-close"
            aria-label="Dismiss the backup reminder"
            onClick={dismissBackupReminder}
          >
            <CloseIcon />
          </button>
        </div>
      ) : null}

      {loading ? (
        <ul className="lib-list lib-skeleton" aria-hidden="true">
          {[0, 1, 2].map((row) => (
            <li className="lib-row" key={row}>
              <span className="lib-skeleton-bar" style={{ width: `${72 - row * 12}%` }} />
            </li>
          ))}
        </ul>
      ) : shelf.length === 0 ? (
        <div className="empty-state">
          <ShelfMark />
          <h2>Your shelf is empty</h2>
          <p>
            PharmaReader reads the books you already own. Import the textbook PDFs and lecture notes you study from,
            and they stay on this phone — no upload, no account, and everything works with the network off.
          </p>
          <ol>
            <li>
              Tap <strong>Import</strong> and pick a file. PDF and EPUB are the usual ones; DOCX, TXT, Markdown and HTML
              work too.
            </li>
            <li>
              Add a voice once in <Link to="/settings#voice-models">Settings → On-device voice models</Link> and the reader can play
              any chapter aloud, in your pocket, on the ward.
            </li>
            <li>
              Tap a sentence to hear it from there. Select it to highlight it, and turn the highlight into a flashcard.
            </li>
          </ol>
          <p className="lib-empty-note">
            Image-only “scanned” PDFs have no text to extract yet, so they open empty. OCR is still to come.
          </p>
          <div className="empty-state-actions">
            <button type="button" className="btn btn-primary" onClick={() => fileInput.current?.click()} disabled={busy}>
              Import a file
            </button>
            <Link className="btn btn-secondary" to="/settings#voice-models">
              Settings
            </Link>
          </div>
        </div>
      ) : (
        <ul className="lib-list">
          {shelf.map((book) => {
            const progress = progressById.get(book.id) ?? null;
            const chapters = chapterCount(book);

            return (
              <li className="lib-row" key={book.id}>
                <Link className="lib-open" to={`/read/${book.id}`}>
                  <span className="lib-row-top">
                    <span className="badge">{FORMAT_LABEL[book.format] ?? book.format.toUpperCase()}</span>
                    <span className="lib-title" title={book.title}>
                      {book.title}
                    </span>
                  </span>
                  <span className="lib-meta">
                    {book.author ? (
                      <>
                        <span className="lib-authors" title={book.author}>
                          {book.author}
                        </span>
                        <span className="lib-meta-dot" aria-hidden="true">
                          ·
                        </span>
                      </>
                    ) : null}
                    <span className="lib-facts">
                      {chapters} {chapters === 1 ? 'chapter' : 'chapters'}
                      {progress === null && <span className="lib-idle"> · Not started</span>}
                    </span>
                  </span>
                  {progress !== null && (
                    <span className="lib-progress">
                      <span className="progress" aria-hidden="true">
                        <span style={{ width: `${progress}%` }} />
                      </span>
                      <span className="lib-pct tnum">{progress}%</span>
                    </span>
                  )}
                </Link>
                <button
                  type="button"
                  className="btn btn-icon btn-ghost lib-more"
                  aria-label={`More actions for ${book.title}`}
                  aria-haspopup="dialog"
                  aria-expanded={menuBook?.id === book.id}
                  onClick={(event) => openBookMenu(book, event.currentTarget)}
                >
                  <MoreIcon />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {menuBook && (
        <BookActionsSheet
          book={menuBook}
          onCancel={closeBookMenu}
          onDelete={() => {
            const book = menuBook;
            closeBookMenu();
            void handleDelete(book);
          }}
        />
      )}
    </section>
  );
}
