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
