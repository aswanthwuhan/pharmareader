import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBackBridge } from '../core/backButton';
import { db } from '../core/db';
import type { BookRecord } from '../core/types';
import { deleteBook } from '../import';
import LibraryPage from './LibraryPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

vi.mock('../import', () => ({
  deleteBook: vi.fn(async () => undefined),
  importFileDetailed: vi.fn(async () => []),
  importText: vi.fn(async () => ({ bookId: 'x', title: 'x', format: 'txt', warnings: [] })),
  importUrl: vi.fn(async () => ({ bookId: 'x', title: 'x', format: 'html', warnings: [] })),
}));
vi.mock('../tts/ModelStatusBanner', () => ({ default: () => null }));

let container: HTMLDivElement;
let root: Root | null = null;

function makeBook(overrides: Partial<BookRecord> = {}): BookRecord {
  return {
    id: 'book-1',
    title: 'Pharmacology Notes',
    author: 'A. Student',
    format: 'txt',
    addedAt: 1,
    fileBlob: new Blob(['notes'], { type: 'text/plain' }),
    topicIds: [],
    parsed: {
      title: 'Pharmacology Notes',
      format: 'txt',
      chapters: [
        {
          id: 'ch-0',
          title: 'Kinetics',
          blocks: [{ id: 'b-0-0', kind: 'p', sentences: [{ id: '0-0-0', text: 'Absorption is the first step.' }] }],
        },
      ],
    },
    ...overrides,
  };
}

async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}

function renderLibrary(): Promise<void> {
  return act(async () => {
    root?.render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<LibraryPage />} />
        </Routes>
      </MemoryRouter>
    );
  });
}

/** The banner and its settings arrive on separate live queries: absence must
 *  be observed for a stretch, not at the first paint after the shelf. */
async function staysHidden(check: () => Element | null, label: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    if (check() !== null) throw new Error(`${label} appeared after ${attempt * 10}ms`);
  }
}

function continueLink(): HTMLAnchorElement | null {
  return container.querySelector<HTMLAnchorElement>('.lib-continue-btn');
}

function backupBanner(): Element | null {
  return container.querySelector('.lib-backup');
}

function moreButton(title = 'Pharmacology Notes'): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`[aria-label="More actions for ${title}"]`);
}

function sheet(): HTMLElement | null {
  return container.querySelector<HTMLElement>('.sheet');
}

async function openMenu(title = 'Pharmacology Notes'): Promise<HTMLButtonElement> {
  await waitFor(() => moreButton(title) !== null, 'row menu button');
  const trigger = moreButton(title);
  if (!trigger) throw new Error('row menu button missing');
  await act(async () => {
    trigger.click();
  });
  await waitFor(() => sheet() !== null, 'book sheet');
  return trigger;
}

function sheetAction(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('.sheet-actions .btn')].find(
    (button) => button.textContent === label,
  );
}

beforeEach(async () => {
  vi.mocked(deleteBook).mockClear();
  await db.delete();
  await db.open();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
    });
    root = null;
  }
  container.remove();
  vi.restoreAllMocks();
  await db.delete();
  await db.open();
});

describe('library: continue listening', () => {
  it('offers the last book with a play link that starts playback', async () => {
    await db.books.put(makeBook());
    await db.settings.put({ key: 'reader.lastBook', value: { bookId: 'book-1', at: Date.now() } });
    await renderLibrary();

    await waitFor(() => continueLink() !== null, 'continue button');
    const link = continueLink();
    expect(link?.textContent).toContain('Continue:');
    expect(link?.textContent).toContain('Pharmacology Notes');
    expect(link?.getAttribute('href')).toBe('/read/book-1?play=1');
  });

  it('hides the button when that book has been deleted', async () => {
    await db.books.put(makeBook({ id: 'book-2', title: 'Another book' }));
    await db.settings.put({ key: 'reader.lastBook', value: { bookId: 'book-1', at: Date.now() } });
    await renderLibrary();

    await waitFor(() => container.querySelector('.lib-list .lib-row') !== null, 'shelf');
    expect(continueLink()).toBeNull();
  });
});

describe('library: backup reminder', () => {
  it('reminds when books exist and no export was ever made', async () => {
    await db.books.put(makeBook());
    await renderLibrary();

    await waitFor(() => backupBanner() !== null, 'backup banner');
    expect(backupBanner()?.textContent).toContain('Back up your notes and cards');
    expect(backupBanner()?.querySelector('a')?.getAttribute('href')).toBe('/settings#backup');
  });

  it('stays quiet while the last export is recent', async () => {
    await db.books.put(makeBook());
    await db.settings.put({ key: 'backup.lastExportAt', value: Date.now() - 24 * 60 * 60 * 1000 });
    await renderLibrary();

    await waitFor(() => container.querySelector('.lib-list .lib-row') !== null, 'shelf');
    await staysHidden(backupBanner, 'backup banner');
  });

  it('reminds again once the export is more than a week old', async () => {
    await db.books.put(makeBook());
    await db.settings.put({ key: 'backup.lastExportAt', value: Date.now() - WEEK_MS - 1000 });
    await renderLibrary();

    await waitFor(() => backupBanner() !== null, 'backup banner');
  });

  it('dismisses for a week by storing the dismissal time', async () => {
    await db.books.put(makeBook());
    await db.settings.put({ key: 'backup.reminderDismissedAt', value: Date.now() - 1000 });
    await renderLibrary();

    await waitFor(() => container.querySelector('.lib-list .lib-row') !== null, 'shelf');
    await staysHidden(backupBanner, 'backup banner');
  });

  it('records the dismissal and hides the banner immediately', async () => {
    await db.books.put(makeBook());
    await renderLibrary();
    await waitFor(() => backupBanner() !== null, 'backup banner');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Dismiss the backup reminder"]')?.click();
    });
    await waitFor(() => backupBanner() === null, 'banner dismissed');
    const row = await db.settings.get('backup.reminderDismissedAt');
    expect(typeof row?.value).toBe('number');
  });

  it('shows nothing on an empty library', async () => {
    await renderLibrary();
    await waitFor(() => container.querySelector('.empty-state') !== null, 'empty state');
    expect(backupBanner()).toBeNull();
    expect(continueLink()).toBeNull();
  });
});

describe('library: row actions', () => {
  const elevenAuthors =
    'Smith, Jones, Patel, Chen, Okafor, Rossi, Kim, Haddad, Silva, Novak, Adeyemi';

  it('opens the book sheet from the More actions button', async () => {
    await db.books.put(makeBook({ author: elevenAuthors }));
    await renderLibrary();
    const trigger = await openMenu();

    const dialog = sheet();
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.querySelector('.sheet-title')?.textContent).toBe('Pharmacology Notes');
    expect(sheetAction('Cancel')?.className).toContain('btn-secondary');
    expect(sheetAction('Delete book')?.className).toContain('btn-danger');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(sheetAction('Cancel'));

    // A long author keeps one clamped line; the whole name survives in the tooltip,
    // and the facts beside it stay on screen.
    const authors = container.querySelector<HTMLElement>('.lib-authors');
    expect(authors?.getAttribute('title')).toBe(elevenAuthors);
    expect(authors?.textContent).toBe(elevenAuthors);
    expect(container.querySelector('.lib-facts')?.textContent).toContain('1 chapter');
  });

  it('closes on Escape and returns focus to the button that opened it', async () => {
    await db.books.put(makeBook());
    await renderLibrary();
    const trigger = await openMenu();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    await waitFor(() => sheet() === null, 'sheet closed');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('closes when the backdrop is tapped', async () => {
    await db.books.put(makeBook());
    await renderLibrary();
    const trigger = await openMenu();

    await act(async () => {
      container.querySelector<HTMLElement>('.sheet-backdrop')?.click();
    });
    await waitFor(() => sheet() === null, 'sheet closed');
    expect(document.activeElement).toBe(trigger);
  });

  it('cancels without deleting the book', async () => {
    await db.books.put(makeBook());
    await renderLibrary();
    await openMenu();

    await act(async () => {
      sheetAction('Cancel')?.click();
    });
    await waitFor(() => sheet() === null, 'sheet closed');
    expect(deleteBook).not.toHaveBeenCalled();
  });

  it('deletes the book from the sheet and closes it', async () => {
    await db.books.put(makeBook());
    await renderLibrary();
    const trigger = await openMenu();

    await act(async () => {
      sheetAction('Delete book')?.click();
    });
    await waitFor(() => sheet() === null, 'sheet closed');
    expect(deleteBook).toHaveBeenCalledTimes(1);
    expect(deleteBook).toHaveBeenCalledWith('book-1');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on the Android back key instead of leaving the library', async () => {
    await db.books.put(makeBook());
    await renderLibrary();
    await openMenu();
    const navigate = vi.fn();
    const dispose = installBackBridge(navigate, () => '/');

    try {
      await act(async () => {
        window.__pharmaBack?.();
      });
      expect(sheet()).toBeNull();
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });
});

describe('library: voice-model links', () => {
  it('points both empty-state settings links at the voice models section', async () => {
    await renderLibrary();
    await waitFor(() => container.querySelector('.empty-state') !== null, 'empty state');

    const links = [...container.querySelectorAll<HTMLAnchorElement>('a[href="/settings#voice-models"]')];
    expect(links).toHaveLength(2);
  });
});

describe('library: the Android back key', () => {
  it('closes an open import panel before leaving the library', async () => {
    await db.books.put(makeBook());
    await renderLibrary();
    await waitFor(() => container.querySelector('.lib-list .lib-row') !== null, 'shelf');
    const navigate = vi.fn();
    const dispose = installBackBridge(navigate, () => '/');

    try {
      await act(async () => {
        [...container.querySelectorAll<HTMLButtonElement>('button')]
          .find((button) => (button.textContent ?? '').includes('Add from web'))
          ?.click();
      });
      expect(container.querySelector('#lib-web-panel')).not.toBeNull();

      await act(async () => {
        window.__pharmaBack?.();
      });
      expect(container.querySelector('#lib-web-panel')).toBeNull();
      expect(navigate).not.toHaveBeenCalled();

      // The library is the menu: nothing open means the press is not handled.
      await act(async () => {
        window.__pharmaBack?.();
      });
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });
});
