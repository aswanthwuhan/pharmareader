/**
 * Storage settings: how much room the app uses, whether the browser has agreed
 * to keep it, and the two things that actually take space (audio cache, book
 * files). Every API here is optional; a browser without it gets a plain note
 * instead of a broken control.
 */
import { useEffect, useState } from 'react';
import { db } from './db';
import { isIos, isStandalone } from './platform';
import { cacheSizeBytes, clearAudio } from '../tts/cache';
import './storage.css';

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

interface Estimate {
  usage: number;
  quota: number;
}

async function readEstimate(): Promise<Estimate | null> {
  const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
  if (!storage || typeof storage.estimate !== 'function') return null;
  try {
    const { usage, quota } = await storage.estimate();
    if (typeof usage !== 'number' || typeof quota !== 'number') return null;
    return { usage, quota };
  } catch {
    return null;
  }
}

async function readPersisted(): Promise<boolean | null> {
  const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
  if (!storage || typeof storage.persisted !== 'function') return null;
  try {
    return await storage.persisted();
  } catch {
    return null;
  }
}

export default function StoragePanel() {
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [estimateAsked, setEstimateAsked] = useState(false);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [canPersist, setCanPersist] = useState(false);
  const [cache, setCache] = useState<number | null>(null);
  const [books, setBooks] = useState<{ count: number; bytes: number } | null>(null);
  const [busy, setBusy] = useState<'cache' | 'books' | 'persist' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Safari on iOS ignores persist() and deletes the whole store after a week
  // without a visit; only the Home Screen install changes that, so say so here.
  const [iosNotInstalled] = useState(() => isIos() && !isStandalone());

  useEffect(() => {
    let alive = true;
    void readEstimate().then((value) => {
      if (!alive) return;
      setEstimate(value);
      setEstimateAsked(true);
    });
    void readPersisted().then((value) => {
      if (!alive) return;
      setPersisted(value);
      setCanPersist(value === false);
    });
    void cacheSizeBytes()
      .then((value) => alive && setCache(value))
      .catch(() => alive && setCache(null));
    return () => {
      alive = false;
    };
  }, []);

  async function keepData() {
    const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
    if (!storage || typeof storage.persist !== 'function') return;
    setBusy('persist');
    setNote(null);
    try {
      const granted = await storage.persist();
      setPersisted(granted);
      setCanPersist(!granted);
      setNote(
        granted
          ? 'The browser will keep your data even when space runs low.'
          : 'The browser declined. Installing the app, or using it more, usually changes its mind.',
      );
    } catch {
      setNote('The browser would not answer. Your data is still here.');
    } finally {
      setBusy(null);
    }
  }

  async function clearCache() {
    if (!window.confirm('Clear the audio cache? Audio is rebuilt the next time you listen.')) return;
    setBusy('cache');
    setNote(null);
    try {
      await clearAudio();
      setCache(await cacheSizeBytes());
      setEstimate(await readEstimate());
      setNote('Audio cache cleared.');
    } catch {
      setNote('Could not clear the audio cache.');
    } finally {
      setBusy(null);
    }
  }

  async function measureBooks() {
    setBusy('books');
    setNote(null);
    try {
      // Reading every book record loads each file blob: only on request.
      let bytes = 0;
      let count = 0;
      await db.books.each((book) => {
        count += 1;
        if (book.fileBlob instanceof Blob) bytes += book.fileBlob.size;
      });
      setBooks({ count, bytes });
    } catch {
      setNote('Could not measure the book files.');
    } finally {
      setBusy(null);
    }
  }

  const usage = estimate ? formatBytes(estimate.usage) : null;
  // "Available" is what is left, not the cap: a user comparing the two numbers
  // must not read a full disk as an empty one.
  const available = estimate ? formatBytes(Math.max(0, estimate.quota - estimate.usage)) : null;

  return (
    <div className="storage-panel">
      <dl className="storage-facts">
        <div className="storage-fact">
          <dt>Space used</dt>
          <dd className="tnum">{usage ?? (estimateAsked ? 'Not available' : 'Checking…')}</dd>
        </div>
        <div className="storage-fact">
          <dt>Space available</dt>
          <dd className="tnum">{available ?? (estimateAsked ? 'Not available' : 'Checking…')}</dd>
        </div>
        <div className="storage-fact">
          <dt>Kept by the browser</dt>
          <dd>
            {persisted === null
              ? 'Not available'
              : persisted
                ? 'Yes — your data is protected from cleanup.'
                : 'No — the browser may clear it when space runs low.'}
          </dd>
        </div>
      </dl>

      {iosNotInstalled ? (
        <p className="muted storage-note">
          On iPhone, Safari deletes this data after 7 days without a visit. Tap Share → Add to Home Screen to keep it.
        </p>
      ) : null}

      {canPersist ? (
        <div className="storage-actions">
          <button type="button" className="btn btn-secondary" onClick={() => void keepData()} disabled={busy !== null}>
            {busy === 'persist' ? 'Asking…' : 'Keep my data'}
          </button>
        </div>
      ) : null}

      {note ? (
        <p className="muted storage-note" role="status">
          {note}
        </p>
      ) : null}

      <details className="disc-sub">
        <summary>Advanced</summary>
        <div className="disc-sub-body">
          <div className="storage-advanced">
            <dl className="storage-facts">
              <div className="storage-fact">
                <dt>Audio cache</dt>
                <dd className="tnum">{cache === null ? '—' : formatBytes(cache)}</dd>
              </div>
              <div className="storage-fact">
                <dt>Book files</dt>
                <dd className="tnum">
                  {books
                    ? `${formatBytes(books.bytes)} (${books.count} ${books.count === 1 ? 'book' : 'books'})`
                    : 'Not measured'}
                </dd>
              </div>
            </dl>

            <div className="storage-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void clearCache()}
                disabled={busy !== null}
              >
                {busy === 'cache' ? 'Clearing…' : 'Clear audio cache'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void measureBooks()}
                disabled={busy !== null}
              >
                {busy === 'books' ? 'Measuring…' : 'Measure books'}
              </button>
            </div>
          </div>
        </div>
      </details>

      <details className="disc-sub">
        <summary>How this works</summary>
        <div className="disc-sub-body">
          <div className="storage-explain">
            <p>
              Both figures come from the browser's storage estimate for this app, so they cover everything it has saved
              here, not only the audio.
            </p>
            <p>
              Audio for a sentence is made once and kept, so listening again does not redo the work. Clearing the cache
              frees that space; the next listen makes it again.
            </p>
            <p>
              Book files are measured only when you ask, because reading each one costs time. A browser may delete a
              site's data when space runs low; it decides on its own whether to keep this one, usually from how much you
              use the app and whether it is installed.
            </p>
          </div>
        </div>
      </details>
    </div>
  );
}
