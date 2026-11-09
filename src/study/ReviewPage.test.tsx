import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../core/db';
import ReviewPage from '../pages/ReviewPage';
import { ensureSyllabusSeeded } from '../syllabus/seed';
import { createCard } from './api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(async () => {
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

async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((element) => element.textContent?.trim() === label);
}

async function openTab(label: string): Promise<void> {
  const tab = button(label);
  expect(tab).toBeDefined();
  await act(async () => {
    tab?.click();
  });
}

describe('ReviewPage tabs', () => {
  it('marks the active view with aria-pressed instead of a half-built tab pattern', async () => {
    await act(async () => {
      root?.render(
        <MemoryRouter>
          <ReviewPage />
        </MemoryRouter>,
      );
    });

    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(container.querySelectorAll('[role="tablist"]')).toHaveLength(0);

    expect(button('Review')?.getAttribute('aria-pressed')).toBe('true');
    expect(button('Cards')?.getAttribute('aria-pressed')).toBe('false');

    await openTab('Cards');
    expect(button('Review')?.getAttribute('aria-pressed')).toBe('false');
    expect(button('Cards')?.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('ReviewPage card delete', () => {
  it('asks before deleting and keeps the card when the answer is no', async () => {
    const card = await createCard({ front: 'Warfarin antidote', back: 'Vitamin K', kind: 'qa' });
    await act(async () => {
      root?.render(
        <MemoryRouter>
          <ReviewPage />
        </MemoryRouter>,
      );
    });
    await openTab('Cards');
    await waitFor(() => container.textContent?.includes('Warfarin antidote') ?? false, 'the card list');

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await act(async () => {
      button('Delete')?.click();
    });
    expect(confirm).toHaveBeenCalled();
    expect(await db.cards.get(card.id)).toBeDefined();

    confirm.mockReturnValue(true);
    await act(async () => {
      button('Delete')?.click();
      // The delete runs through a Dexie transaction; let it settle inside act.
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(await db.cards.get(card.id)).toBeUndefined();
  });
});

describe('ReviewPage topic deep link', () => {
  it('preselects the topic named in ?topic=', async () => {
    await ensureSyllabusSeeded();
    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={['/review?topic=cvs-antihypertensives']}>
          <ReviewPage />
        </MemoryRouter>,
      );
    });
    await waitFor(() => container.querySelector('.tp-chip') !== null, 'the preselected topic chip');
    expect(container.querySelector('.tp-chip')?.textContent).toContain('Antihypertensives');
  });
});
