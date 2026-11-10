import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from './db';
import type { BookRecord } from './types';
import StoragePanel, { formatBytes } from './StoragePanel';

const h = vi.hoisted(() => ({
  cacheBytes: { value: 4 * 1024 * 1024 },
  cleared: { value: 0 },
}));

vi.mock('../tts/cache', () => ({
  cacheSizeBytes: async () => h.cacheBytes.value,
  clearAudio: async () => {
    h.cleared.value += 1;
    h.cacheBytes.value = 0;
  },
}));

// React 19 keeps act() warnings quiet only when this flag is set.
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_700_000_000_000;

let container: HTMLDivElement;
let root: Root;

function stubStorage(value: unknown): void {
  Object.defineProperty(navigator, 'storage', { configurable: true, value });
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<StoragePanel />);
  });
  await flush(10);
}

function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no "${text}" button`);
  return found;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
  await flush(10);
}

function bookRecord(id: string): BookRecord {
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

beforeEach(() => {
  h.cacheBytes.value = 4 * 1024 * 1024;
  h.cleared.value = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await act(async () => root.unmount());
  container?.remove();
  delete (navigator as { storage?: unknown }).storage;
  for (const table of db.tables) await table.clear();
});

describe('formatBytes', () => {
  it('picks a readable unit', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(120 * 1024 * 1024)).toBe('120 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
  });
});

describe('StoragePanel', () => {
  it('degrades gracefully where the Storage API is missing', async () => {
    stubStorage(undefined);
    await mount();

    // No estimate and no persistence check: say so instead of inventing numbers.
    expect(container.textContent).toContain('Not available');
    expect(container.textContent).toContain('4.0 MB');
    expect(container.textContent).toContain('Not measured');
    expect(container.querySelectorAll('button')).toHaveLength(2);
    expect(container.textContent).not.toContain('Keep my data');
  });

  it('shows space usage and can ask the browser to keep the data', async () => {
    const persist = vi.fn(async () => true);
    stubStorage({
      estimate: async () => ({ usage: 5 * 1024 * 1024, quota: 100 * 1024 * 1024 }),
      persisted: async () => false,
      persist,
    });
    await mount();

    expect(container.textContent).toContain('5.0 MB');
    // Available is the remainder, not the 100 MB cap: 95 MB left of 100 MB.
    expect(container.textContent).toContain('95 MB');
    expect(container.querySelectorAll('.storage-fact')[1]?.textContent).toContain('95 MB');
    expect(container.textContent).toContain('No — the browser may clear it when space runs low.');

    await click(button('Keep my data'));

    expect(persist).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Yes — your data is protected from cleanup.');
    expect(container.textContent).toContain('The browser will keep your data even when space runs low.');
    expect(container.textContent).not.toContain('Keep my data');
  });

  it('clears the audio cache only after a confirmation', async () => {
    stubStorage({
      estimate: async () => ({ usage: 5 * 1024 * 1024, quota: 100 * 1024 * 1024 }),
      persisted: async () => true,
    });
    await mount();
    expect(container.textContent).toContain('4.0 MB');

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await click(button('Clear audio cache'));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(h.cleared.value).toBe(0);
    expect(container.textContent).toContain('4.0 MB');

    confirm.mockReturnValue(true);
    await click(button('Clear audio cache'));
    expect(h.cleared.value).toBe(1);
    expect(container.textContent).toContain('Audio cache cleared.');
    expect(container.textContent).toContain('0 B');
  });

  it('measures book files only when asked', async () => {
    stubStorage(undefined);
    await db.books.bulkPut([bookRecord('b1'), bookRecord('b2')]);
    await mount();
    expect(container.textContent).toContain('Not measured');

    await click(button('Measure books'));

    expect(container.textContent).toContain('(2 books)');
  });
});
