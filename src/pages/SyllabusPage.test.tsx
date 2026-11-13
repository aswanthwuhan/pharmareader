import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../core/db';
import { ensureSyllabusSeeded } from '../syllabus/seed';
import SyllabusPage from './SyllabusPage';

const progress = vi.hoisted(() => ({
  topicProgressAll: vi.fn(async () => new Map()),
}));

// The page should aggregate once for the whole tree; a per-row call would make
// this spy fire 26+ times with 26 domains.
vi.mock('../syllabus/progress', () => ({ topicProgressAll: progress.topicProgressAll }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(async () => {
  await db.delete();
  await db.open();
  await ensureSyllabusSeeded();
  progress.topicProgressAll.mockClear();
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

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('SyllabusPage progress cost', () => {
  it('computes progress once for the whole tree, not once per row', async () => {
    await act(async () => {
      root?.render(
        <MemoryRouter>
          <SyllabusPage />
        </MemoryRouter>,
      );
    });
    await waitFor(() => container.textContent?.includes('General Pharmacology') ?? false, 'the domain list');

    expect(container.querySelectorAll('.syl-node')).toHaveLength(26);
    expect(progress.topicProgressAll).toHaveBeenCalledTimes(1);
  });
});

describe('SyllabusPage actions menu', () => {
  it('flips above the button when the menu would run off a short screen', async () => {
    // jsdom lays nothing out, so the menu's real bottom is faked; the page
    // reads it after the menu mounts and decides whether to flip it.
    let bottom = 120;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const height = this.classList.contains('syl-menu') ? 140 : 20;
      return {
        top: this.classList.contains('syl-menu') ? bottom - height : 0,
        bottom,
        left: 0,
        right: 200,
        width: 200,
        height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });

    await act(async () => {
      root?.render(
        <MemoryRouter>
          <SyllabusPage />
        </MemoryRouter>,
      );
    });
    await waitFor(() => container.textContent?.includes('General Pharmacology') ?? false, 'the domain list');

    // A row only offers its actions once it is open.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.syl-twisty')?.click();
    });
    await waitFor(() => container.querySelector('.syl-menu-btn') !== null, 'the Actions button');
    const actions = container.querySelector<HTMLButtonElement>('.syl-menu-btn')!;

    // Room to spare: the menu hangs below the button, as it always has.
    await act(async () => {
      actions.click();
    });
    await waitFor(() => container.querySelector('.syl-menu') !== null, 'the first menu');
    expect(container.querySelector('.syl-menu')?.hasAttribute('data-placement')).toBe(false);

    // A menu whose bottom is past the viewport flips to open upwards; the
    // placement is re-measured for every menu, not remembered from the last.
    await act(async () => {
      actions.click();
    });
    await waitFor(() => container.querySelector('.syl-menu') === null, 'the menu closed');
    bottom = window.innerHeight + 40;
    await act(async () => {
      actions.click();
    });
    await waitFor(
      () => container.querySelector(".syl-menu[data-placement='up']") !== null,
      'the menu flipped upwards',
    );
  });
});
