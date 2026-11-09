import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../core/db';
import { createCard } from './api';
import ReviewSession from './ReviewSession';

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
  await db.delete();
  await db.open();
});

/** Poll until the rendered text contains `text` (Dexie work resolves off the microtask queue). */
async function waitForText(text: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (container.textContent?.includes(text)) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error(`timed out waiting for "${text}"; saw "${container.textContent ?? ''}"`);
}

async function key(target: EventTarget, value: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));
  });
}

async function mountSession(): Promise<void> {
  await act(async () => {
    root?.render(<ReviewSession />);
  });
  await waitForText('Show answer');
}

describe('ReviewSession keyboard shortcuts', () => {
  it('reveals on Space from the page but leaves focused controls alone', async () => {
    await createCard({ front: 'Q', back: 'A', kind: 'qa' });
    await mountSession();

    // A focused button elsewhere on the page owns Space/Enter.
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();
    await key(elsewhere, ' ');
    expect(container.textContent).toContain('Show answer');

    await key(document.body, ' ');
    expect(container.textContent).toContain('Again');
    elsewhere.remove();
  });

  it('rates with the 1-4 keys once the answer is shown', async () => {
    const card = await createCard({ front: 'Q', back: 'A', kind: 'qa' });
    await mountSession();

    await key(document.body, ' ');
    await key(document.body, '3');
    await waitForText('Session complete');

    const logs = await db.reviewLogs.where('cardId').equals(card.id).toArray();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.rating).toBe(3);
  });

  it('does not update state after the session is unmounted mid-rating', async () => {
    const card = await createCard({ front: 'Q', back: 'A', kind: 'qa' });
    await mountSession();
    await key(document.body, ' ');

    const again = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Again'));
    expect(again).toBeDefined();

    await act(async () => {
      again?.click();
      root?.unmount();
      root = null;
    });
    // Let the pending review settle with no live component behind it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(await db.reviewLogs.where('cardId').equals(card.id).count()).toBe(1);
  });
});
