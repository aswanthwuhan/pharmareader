import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { db } from '../core/db';
import type { BookRecord } from '../core/types';
import { deleteBook, importFileDetailed, importText, importUrl } from '../import';
import '../import/library.css';

const ACCEPT = '.pdf,.epub,.docx,.txt,.md,.html';

const FORMAT_LABEL: Record<BookRecord['format'], string> = {
  pdf: 'PDF',
  epub: 'EPUB',
  docx: 'DOCX',
  txt: 'TXT',
  md: 'MD',
  html: 'HTML',
};

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

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 7h15" />
      <path d="M9.5 7V4.8h5V7" />
      <path d="M6.6 7l.8 12.3a1.8 1.8 0 0 0 1.8 1.7h5.6a1.8 1.8 0 0 0 1.8-1.7L17.4 7" />
      <path d="M10.4 11v6M13.6 11v6" />
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
  const [status, setStatus] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const [panel, setPanel] = useState<'none' | 'web' | 'text'>('none');
  const [url, setUrl] = useState('');
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteText, setPasteText] = useState('');

  const busy = status !== null;
  const loading = books === undefined;
  const shelf = books ?? [];

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
            { file: file.name, message: warning, scanned: /scanned/i.test(warning) },
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
    if (!window.confirm(`Delete “${book.title}”? Its highlights, bookmarks and cards go with it.`)) return;

    try {
      await deleteBook(book.id);
    } catch (error) {
      setErrors([`Could not delete “${book.title}”: ${errorMessage(error)}`]);
    }
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
          <h1>Library</h1>
          <p className="app-bar-sub">{countSub}</p>
        </div>
        <div className="app-bar-actions">
          <button type="button" className="btn btn-primary" onClick={() => fileInput.current?.click()} disabled={busy}>
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
              Add a voice once in <Link to="/settings">Settings → On-device voice models</Link> and the reader can play
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
            <Link className="btn btn-secondary" to="/settings">
              Settings
            </Link>
          </div>
        </div>
      ) : (
        <ul className="lib-list">
          {shelf.map((book) => {
            const progress = progressById.get(book.id) ?? null;
            const chapters = chapterCount(book);
            const meta = [book.author, `${chapters} ${chapters === 1 ? 'chapter' : 'chapters'}`]
              .filter(Boolean)
              .join(' · ');

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
                    {meta}
                    {progress === null && <span className="lib-idle"> · Not started</span>}
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
                  className="btn btn-icon btn-ghost lib-delete"
                  aria-label={`Delete ${book.title}`}
                  onClick={() => void handleDelete(book)}
                >
                  <TrashIcon />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
