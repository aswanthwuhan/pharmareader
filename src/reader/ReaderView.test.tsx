import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../core/db';
import type { BookRecord } from '../core/types';
import ReaderView from './ReaderView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BOOK_ID = 'book-reader-test';

// The player drives audio; here it only records the queue it was given.
const playerMock = vi.hoisted(() => {
  interface Call {
    items: { id: string; text: string }[];
    startIndex: number;
    onSentence?(id: string): void;
    onDone?(): void;
    played: number;
  }
  const calls: Call[] = [];
  function createPlayer(options: Omit<Call, 'played'>) {
    const call: Call = { ...options, played: 0 };
    calls.push(call);
    return {
      play() {
        call.played += 1;
      },
      pause() {},
      resume() {},
      stop() {},
      seek() {},
    };
  }
  return { calls, createPlayer };
});

vi.mock('../tts/player', () => ({ createPlayer: playerMock.createPlayer }));

vi.mock('../tts/registry', () => ({
  describeEngine: async () => ({
    preferred: true,
    engine: {
      id: 'system',
      label: 'System voices',
      capabilities: { streaming: true, prerender: false, wordBoundaries: true, needsDownload: false },
      isReady: async () => true,
      prepare: async () => undefined,
      listVoices: async () => [],
      speak: async () => undefined,
      stop() {},
      pause() {},
      resume() {},
    },
  }),
}));

// pdfjs is only reached through the lazily loaded page view, but mock it so a
// stray import can never touch a real worker or canvas in jsdom.
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({ promise: Promise.resolve({ numPages: 1 }), destroy: () => undefined }),
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'worker.js' }));
vi.mock('../ai/AiActions', () => ({ default: () => null }));
vi.mock('../syllabus/TopicPicker', () => ({ default: () => null }));

let container: HTMLDivElement;
let root: Root | null = null;

function makeBook(overrides: Partial<BookRecord> = {}): BookRecord {
  return {
    id: BOOK_ID,
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
          blocks: [
            {
              id: 'b-0-0',
              kind: 'p',
              sentences: [
                { id: '0-0-0', text: 'Absorption is the first step.' },
                { id: '0-0-1', text: 'Bioavailability matters.' },
              ],
            },
          ],
        },
        {
          id: 'ch-1',
          title: 'Dynamics',
          blocks: [{ id: 'b-1-0', kind: 'p', sentences: [{ id: '1-0-0', text: 'Receptors bind drugs.' }] }],
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

function renderReader(): Promise<void> {
  return act(async () => {
    root?.render(
      <MemoryRouter initialEntries={[`/read/${BOOK_ID}`]}>
        <Routes>
          <Route path="/read/:bookId" element={<ReaderView />} />
        </Routes>
      </MemoryRouter>
    );
  });
}

function sentence(id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-sid="${id}"]`);
}

function readingId(): string | null {
  return container.querySelector('.reading')?.getAttribute('data-sid') ?? null;
}

function playButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('[aria-label="Play"]');
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  playerMock.calls.length = 0;
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
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

describe('ReaderView reflow', () => {
  it('renders the chapter as tappable sentences', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitFor(() => sentence('0-0-0') !== null, 'first sentence');

    const text = container.textContent ?? '';
    expect(text).toContain('Absorption is the first step.');
    expect(text).toContain('Bioavailability matters.');
    expect(text).toContain('Kinetics');
    // One chapter at a time: the second chapter is not rendered.
    expect(sentence('1-0-0')).toBeNull();
  });

  it('restores lastPos and marks that sentence as reading', async () => {
    await db.books.put(makeBook({ lastPos: { chapterId: 'ch-1', sentenceId: '1-0-0' } }));
    await renderReader();
    await waitFor(() => readingId() === '1-0-0', 'restored cursor');
    expect(container.textContent).toContain('Dynamics');
  });

  it('moves the cursor to a tapped sentence', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitFor(() => sentence('0-0-0') !== null, 'first sentence');

    const second = sentence('0-0-1');
    expect(second).not.toBeNull();
    await act(async () => {
      second?.click();
    });

    expect(readingId()).toBe('0-0-1');
  });

  it('starts the player from the cursor with the rest of the chapter', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitFor(() => playButton() !== null, 'play button');

    await act(async () => {
      playButton()?.click();
    });
    await waitFor(() => playerMock.calls.length === 1, 'player created');

    const call = playerMock.calls[0];
    expect(call?.items.map((item) => item.id)).toEqual(['0-0-0', '0-0-1']);
    expect(call?.startIndex).toBe(0);
    expect(call?.played).toBe(1);

    // The spoken sentence becomes the cursor.
    await act(async () => {
      call?.onSentence?.('0-0-1');
    });
    expect(readingId()).toBe('0-0-1');
  });

  it('saves the reading position after the cursor settles', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitFor(() => sentence('0-0-1') !== null, 'second sentence');

    await act(async () => {
      sentence('0-0-1')?.click();
    });
    await waitFor(async () => (await db.books.get(BOOK_ID))?.lastPos?.sentenceId === '0-0-1', 'lastPos saved');
  });

  it('creates a highlight from a long-press selection', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitFor(() => sentence('0-0-0') !== null, 'first sentence');

    await act(async () => {
      sentence('0-0-0')?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });

    const swatch = container.querySelector<HTMLButtonElement>('[aria-label="Yellow highlight"]');
    expect(swatch).not.toBeNull();
    await act(async () => {
      swatch?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(async () => (await db.highlights.count()) === 1, 'highlight saved');
    const saved = await db.highlights.toCollection().first();
    expect(saved?.sentenceIds).toEqual(['0-0-0']);
    expect(saved?.color).toBe('yellow');
    expect(saved?.bookId).toBe(BOOK_ID);
  });
});
