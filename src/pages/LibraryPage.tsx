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

export default function LibraryPage() {
  const navigate = useNavigate();
  const books = useLiveQuery(() => db.books.orderBy('addedAt').reverse().toArray(), [], [] as BookRecord[]);

  // Walking every sentence of every book is not free, and the page re-renders on
  // each keystroke in the URL field: do it once per library change, not per render.
  const progressById = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const book of books) map.set(book.id, readingProgress(book));
    return map;
  }, [books]);

  const fileInput = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [panel, setPanel] = useState<'none' | 'web' | 'text'>('none');
  const [url, setUrl] = useState('');
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteText, setPasteText] = useState('');

  const busy = status !== null;

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
        if (result.warning) setWarnings((current) => [...current, `${file.name}: ${result.warning}`]);
        if (files.length === 1 && !result.warning) navigate(`/read/${result.bookId}`);
      } catch (error) {
        setErrors((current) => [...current, errorMessage(error)]);
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

  return (
    <section className="page library">
      <header className="library-head">
        <h1>Library</h1>
        <button
          type="button"
          className="lib-btn lib-btn-primary"
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
          onChange={(event) => void handleFiles(event.target.files)}
        />
      </header>

      <div className="lib-actions">
        <button
          type="button"
          className="lib-btn"
          aria-expanded={panel === 'web'}
          onClick={() => setPanel(panel === 'web' ? 'none' : 'web')}
          disabled={busy}
        >
          Add from web
        </button>
        <button
          type="button"
          className="lib-btn"
          aria-expanded={panel === 'text'}
          onClick={() => setPanel(panel === 'text' ? 'none' : 'text')}
          disabled={busy}
        >
          Paste text
        </button>
      </div>

      {panel === 'web' && (
        <form className="lib-panel" onSubmit={(event) => void handleUrl(event)}>
          <label className="lib-field">
            <span>Article URL</span>
            <input
              className="lib-input"
              type="url"
              inputMode="url"
              placeholder="https://…"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              required
            />
          </label>
          <button type="submit" className="lib-btn lib-btn-primary" disabled={busy}>
            Import article
          </button>
          <p className="muted lib-hint">Some sites block browser fetches — paste the text instead.</p>
        </form>
      )}

      {panel === 'text' && (
        <form className="lib-panel" onSubmit={(event) => void handleText(event)}>
          <label className="lib-field">
            <span>Title</span>
            <input
              className="lib-input"
              type="text"
              placeholder="Optional title"
              value={pasteTitle}
              onChange={(event) => setPasteTitle(event.target.value)}
            />
          </label>
          <label className="lib-field">
            <span>Text</span>
            <textarea
              className="lib-textarea"
              rows={8}
              placeholder="Paste an article, chapter or paper…"
              value={pasteText}
              onChange={(event) => setPasteText(event.target.value)}
              required
            />
          </label>
          <button type="submit" className="lib-btn lib-btn-primary" disabled={busy}>
            Save text
          </button>
        </form>
      )}

      {status && (
        <p className="lib-status" role="status">
          <span className="lib-spinner" aria-hidden="true" />
          {status}
        </p>
      )}

      {errors.map((message, index) => (
        <p className="lib-error" role="alert" key={`${index}-${message}`}>
          {message}
        </p>
      ))}

      {warnings.map((message) => (
        <p className="lib-warning" key={message}>
          {message}
        </p>
      ))}

      {books.length === 0 && !status ? (
        <div className="lib-empty">
          <h2>Nothing here yet</h2>
          <p>
            Import a PDF, EPUB, DOCX, TXT, Markdown or HTML book, add a web article by its address, or paste text
            straight in. Everything is parsed and stored on this device — no upload, no account.
          </p>
        </div>
      ) : (
        <ul className="lib-list">
          {books.map((book) => {
            const progress = progressById.get(book.id) ?? null;
            const meta = [book.author, FORMAT_LABEL[book.format] ?? book.format.toUpperCase(), progress !== null ? `${progress}% read` : null]
              .filter(Boolean)
              .join(' · ');

            return (
              <li className="lib-row" key={book.id}>
                <Link className="lib-open" to={`/read/${book.id}`}>
                  <span className="lib-title">{book.title}</span>
                  <span className="lib-meta">{meta}</span>
                </Link>
                <button
                  type="button"
                  className="lib-delete"
                  aria-label={`Delete ${book.title}`}
                  onClick={() => void handleDelete(book)}
                >
                  Delete
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
