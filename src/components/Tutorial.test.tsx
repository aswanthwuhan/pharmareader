import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../core/db';
import { getSetting } from '../core/settings';
import Tutorial, { TUTORIAL_SEEN_KEY, TUTORIAL_STEPS } from './Tutorial';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;
let closed = 0;
let fakes: HTMLElement[] = [];

const EMPTY_LIBRARY_TITLE = 'Add a book to go further';
/** The tour on a fresh install, before any book: the sample list, then the one closing card. */
const NO_BOOK_TITLES = [...TUTORIAL_STEPS.filter((step) => !step.needsBook).map((step) => step.title), EMPTY_LIBRARY_TITLE];
const NO_BOOK_STEP_COUNT = NO_BOOK_TITLES.length;

interface Target {
  kind: 'data' | 'id' | 'class';
  value: string;
}

/** The controls the tour points at, as the real pages would carry them. */
const DEFAULT_TARGETS: Target[] = [
  { kind: 'data', value: 'import' },
  { kind: 'data', value: 'add-other' },
  { kind: 'data', value: 'nav' },
  { kind: 'id', value: 'voice-models' },
  { kind: 'id', value: 'pdf-layout' },
  { kind: 'id', value: 'voice' },
  { kind: 'id', value: 'backup' },
];

function addTargets(targets: Target[]): void {
  for (const target of targets) {
    if (target.kind === 'data') {
      const button = document.createElement('button');
      button.dataset.tour = target.value;
      button.textContent = target.value;
      document.body.appendChild(button);
      fakes.push(button);
      continue;
    }
    if (target.kind === 'class') {
      // A control the reader already renders, reached by a plain CSS selector.
      const box = document.createElement('div');
      box.className = target.value;
      box.textContent = target.value;
      document.body.appendChild(box);
      fakes.push(box);
      continue;
    }
    // A Settings row: the section carries the id and its header carries the ring.
    const section = document.createElement('section');
    section.id = target.value;
    const head = document.createElement('button');
    head.className = 'disc-head';
    head.textContent = target.value;
    section.appendChild(head);
    document.body.appendChild(section);
    fakes.push(section);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function flush(ms = 5): Promise<void> {
  await act(async () => {
    await sleep(ms);
  });
}

async function waitFor<T>(check: () => T | null | undefined | false, label: string, timeout = 4000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`);
    await flush(10);
  }
}

function card(): HTMLElement | null {
  return container.querySelector<HTMLElement>('.tour-card');
}

function title(): string | null {
  return card()?.querySelector('.tour-title')?.textContent ?? null;
}

function counter(): string {
  return container.querySelector('.tour-count')?.textContent ?? '';
}

function action(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('.tour-actions .btn')].find(
    (candidate) => candidate.textContent === label,
  );
  if (!found) throw new Error(`no tour button "${label}"`);
  return found;
}

async function click(label: string): Promise<void> {
  await act(async () => {
    action(label).click();
  });
  await flush(0);
}

async function arrived(step: number): Promise<void> {
  await waitFor(() => (title() === NO_BOOK_TITLES[step] ? true : null), `step ${step + 1}`);
}

async function start(targets: Target[] = DEFAULT_TARGETS): Promise<void> {
  addTargets(targets);
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={['/']}>
        <Tutorial
          onClose={() => {
            closed += 1;
          }}
        />
      </MemoryRouter>,
    );
  });
}

async function seen(): Promise<boolean> {
  await act(async () => {
    await sleep(20);
  });
  return getSetting<boolean>(TUTORIAL_SEEN_KEY, false);
}

beforeEach(async () => {
  closed = 0;
  await db.delete();
  await db.open();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container.remove();
  for (const fake of fakes) fake.remove();
  fakes = [];
});

describe('Tutorial', () => {
  it('lights the real control and explains it', async () => {
    await start();

    await arrived(0);
    expect(container.querySelector('.tour-spot')).not.toBeNull();
    expect(counter()).toBe(`1 of ${NO_BOOK_STEP_COUNT}`);

    const dialog = card();
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    const labelId = dialog?.getAttribute('aria-labelledby') ?? '';
    expect(labelId).not.toBe('');
    expect(document.getElementById(labelId)?.textContent).toBe(TUTORIAL_STEPS[0].title);

    await waitFor(() => document.activeElement === action('Next'), 'focus on Next');
  });

  it('moves between steps and back, with the counter in the action row', async () => {
    await start();
    await arrived(0);
    expect(() => action('Back')).toThrow();

    await click('Next');
    await arrived(1);
    expect(counter()).toBe(`2 of ${NO_BOOK_STEP_COUNT}`);

    await click('Back');
    await arrived(0);
    expect(counter()).toBe(`1 of ${NO_BOOK_STEP_COUNT}`);
    expect(() => action('Back')).toThrow();
  });

  it('Skip closes the tour and records it as seen', async () => {
    await start();
    await arrived(0);

    await click('Skip');
    await waitFor(() => closed === 1, 'close');
    expect(await seen()).toBe(true);
  });

  it('Escape closes the tour and records it as seen', async () => {
    await start();
    await arrived(0);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    });
    await waitFor(() => closed === 1, 'close');
    expect(await seen()).toBe(true);
  });

  it('Done closes on the last step', async () => {
    await start();
    await arrived(0);
    for (let index = 1; index < NO_BOOK_STEP_COUNT; index += 1) {
      await click('Next');
      await arrived(index);
    }
    expect(title()).toBe(EMPTY_LIBRARY_TITLE);
    expect(action('Done')).toBeTruthy();

    await click('Done');
    await waitFor(() => closed === 1, 'close');
    expect(await seen()).toBe(true);
  });

  it('falls back to a centred card when a target never appears', async () => {
    await start(DEFAULT_TARGETS.filter((target) => target.value !== 'import'));
    // The first step points at Import, which is not on the page in this test.
    await waitFor(() => (title() === NO_BOOK_TITLES[0] ? true : null), 'centred fallback', 3000);

    expect(container.querySelector('.tour-spot')).toBeNull();
    expect(container.querySelector('.tour-scrim')).not.toBeNull();
    expect(card()?.className).toContain('tour-card--centre');
  });

  it('skips the Reader steps when the Library is empty', async () => {
    await start();
    await arrived(0);

    const seenTitles: string[] = [];
    for (let index = 0; index < NO_BOOK_STEP_COUNT; index += 1) {
      const shown = await waitFor(() => title(), `step ${index + 1}`);
      seenTitles.push(shown);
      if (index < NO_BOOK_STEP_COUNT - 1) {
        await click('Next');
      }
    }

    expect(seenTitles).toHaveLength(NO_BOOK_STEP_COUNT);
    expect(seenTitles[0]).toBe(NO_BOOK_TITLES[0]);
    expect(seenTitles[NO_BOOK_STEP_COUNT - 1]).toBe(EMPTY_LIBRARY_TITLE);

    const bookTitles = TUTORIAL_STEPS.filter((step) => step.needsBook).map((step) => step.title);
    expect(bookTitles.length).toBeGreaterThan(0);
    expect(seenTitles.filter((shown) => bookTitles.includes(shown))).toEqual([]);

    // The last card points at Settings → About to replay the tour.
    expect(card()?.textContent).toContain('How to use PharmaReader');
  });

  it('walks all twenty steps once a book exists', async () => {
    await db.books.put({
      id: 'book-1',
      title: 'A book',
      format: 'pdf',
      addedAt: 1,
      fileBlob: new Blob(['x']),
      parsed: { title: 'A book', format: 'pdf', chapters: [] },
      topicIds: [],
    });
    await start([
      ...DEFAULT_TARGETS,
      { kind: 'data', value: 'play' },
      { kind: 'data', value: 'speed' },
      { kind: 'data', value: 'step' },
      { kind: 'data', value: 'more' },
      { kind: 'data', value: 'contents' },
      { kind: 'data', value: 'type' },
      { kind: 'data', value: 'view-switch' },
      { kind: 'class', value: 'rd-pdf-controls' },
    ]);

    const titles = TUTORIAL_STEPS.map((step) => step.title);
    expect(titles).toHaveLength(20);
    await waitFor(() => (title() === titles[0] ? true : null), 'first step');

    for (let index = 1; index < titles.length; index += 1) {
      await click('Next');
      await waitFor(() => (title() === titles[index] ? true : null), `step ${index + 1}`);
    }
    expect(counter()).toBe('20 of 20');
    expect(action('Done')).toBeTruthy();
  });
});
