import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../core/db';
import { createCard, fromFsrs, toFsrs } from './api';
import { State } from 'ts-fsrs';
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

describe('ReviewSession previews', () => {
  it('previews and rates a card whose last review is ahead of the clock', async () => {
    // A clock moved back after a rating leaves last_review in the future. ts-fsrs
    // counts the gap in whole UTC days, so it refuses a card dated two days ahead
    // with "Invalid delta_t" — in `repeat()` too, which runs while rendering.
    const ahead = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const card = await createCard({
      front: 'Q',
      back: 'A',
      kind: 'qa',
      fsrs: toFsrs(
        fromFsrs({
          due: new Date(Date.now() - 60_000).toISOString(),
          last_review: ahead.toISOString(),
          state: State.Review,
          reps: 3,
          stability: 10,
          difficulty: 5,
          scheduled_days: 3,
        }),
      ),
    });

    await mountSession();
    await key(document.body, ' ');
    const good = [...container.querySelectorAll<HTMLButtonElement>('.review-rate')].find((button) =>
      button.textContent?.includes('Good'),
    );
    // The four interval previews are computed and labelled.
    expect(good?.getAttribute('aria-label')).toMatch(/^Good, next review in \d+[a-z]/);

    await key(document.body, '3');
    await waitForText('Session complete');
    expect(await db.reviewLogs.where('cardId').equals(card.id).count()).toBe(1);
  });
});

describe('ReviewSession undo and double taps', () => {
  const ratingButton = (label: string): HTMLButtonElement => {
    const button = [...container.querySelectorAll<HTMLButtonElement>('.review-rate')].find((candidate) =>
      candidate.textContent?.includes(label),
    );
    if (!button) throw new Error(`no ${label} rating button; saw "${container.textContent ?? ''}"`);
    return button;
  };

  it('offers no undo until something has been rated', async () => {
    await createCard({ front: 'Q', back: 'A', kind: 'qa' });
    await mountSession();
    expect(container.querySelector('button[aria-label="Undo last rating"]')).toBeNull();
  });

  it('puts the rated card back unrevealed and deletes the log it wrote', async () => {
    const card = await createCard({ front: 'Q', back: 'A', kind: 'qa' });
    const before = await db.cards.get(card.id);
    await mountSession();

    await key(document.body, ' ');
    await key(document.body, '3');
    await waitForText('Session complete');

    const undo = container.querySelector<HTMLButtonElement>('button[aria-label="Undo last rating"]');
    expect(undo).not.toBeNull();
    await act(async () => {
      undo?.click();
    });
    await waitForText('Show answer');

    // The same card is current again, and it is not revealed.
    expect(container.textContent).toContain('Card 1 of 1');
    expect(container.textContent).toContain('Q');
    expect(container.textContent).not.toContain('Again');
    // Nothing left to take back, and the rating is gone from storage.
    expect(container.querySelector('button[aria-label="Undo last rating"]')).toBeNull();
    expect(await db.cards.get(card.id)).toEqual(before);
    expect(await db.reviewLogs.where('cardId').equals(card.id).count()).toBe(0);
  });

  it('records one review when a rating is clicked twice in the same tick', async () => {
    const card = await createCard({ front: 'Q', back: 'A', kind: 'qa' });
    await mountSession();
    await key(document.body, ' ');
    const good = ratingButton('Good');

    await act(async () => {
      good.click();
      good.click();
    });
    await waitForText('Session complete');
    // Let a second rating settle if the guard let one through.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(await db.reviewLogs.where('cardId').equals(card.id).count()).toBe(1);
    expect(container.textContent).toContain('You rated 1 card');
  });
});
