import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../core/db';

/** The save target is the only thing that needs a phone; everything else is the page. */
const save = vi.hoisted(() => ({ error: { value: null as unknown } }));

vi.mock('../core/saveFile', () => ({
  saveFile: async () => {
    if (save.error.value !== null) throw save.error.value;
    return { location: 'Documents/PharmaReader/notes.md' };
  },
}));

const { default: ReviewPage } = await import('./ReviewPage');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(async () => {
  save.error.value = null;
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

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((element) => element.textContent?.trim() === label);
}

function status(): string {
  return container.querySelector('.study-status')?.textContent ?? '';
}

async function openExportTab(): Promise<void> {
  await act(async () => {
    root?.render(
      <MemoryRouter>
        <ReviewPage />
      </MemoryRouter>,
    );
  });
  await act(async () => {
    button('Export')?.click();
  });
}

describe('ReviewPage export', () => {
  it('shows why the file was not saved instead of a generic message', async () => {
    const permission =
      'PharmaReader needs storage permission to save files in Documents. Allow it in Android Settings → Apps → PharmaReader → Permissions, then try again.';
    save.error.value = new Error(permission);

    await openExportTab();
    await act(async () => {
      button('Download notes (.md)')?.click();
    });

    await waitFor(() => status().includes('storage permission'), 'the permission message');
    expect(status()).toContain('Android Settings');
    expect(status()).not.toBe('Could not export notes.');
  });

  it('reports the saved location, and falls back when the failure carries no message', async () => {
    await openExportTab();
    await act(async () => {
      button('Download notes (.md)')?.click();
    });
    await waitFor(() => status().includes('Notes saved to Documents/PharmaReader'), 'the saved location');

    // A thrown string is all some bridges give; the page still has to say something.
    save.error.value = 'gone';
    await act(async () => {
      button('Download cards (.csv)')?.click();
    });
    await waitFor(() => status() === 'Could not export cards.', 'the fallback message');
  });
});
