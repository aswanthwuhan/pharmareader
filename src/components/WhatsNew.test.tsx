import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBackBridge } from '../core/backButton';
import { db } from '../core/db';
import { getSetting } from '../core/settings';
import { changelogSection } from '../core/version';
import WhatsNew from './WhatsNew';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;
let closed: number;

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="trigger" onClick={() => setOpen(true)}>
        What’s new
      </button>
      {open ? (
        <WhatsNew
          version="0.3.0"
          onClose={() => {
            setOpen(false);
            closed += 1;
          }}
        />
      ) : null}
    </>
  );
}

function sheet(): HTMLElement | null {
  return container.querySelector<HTMLElement>('.sheet');
}

function sheetButton(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('.sheet-actions .btn')].find(
    (button) => button.textContent === label,
  );
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Focus and click the trigger, the way a reader opens the sheet. */
async function openSheet(): Promise<HTMLButtonElement> {
  const trigger = container.querySelector<HTMLButtonElement>('.trigger');
  if (!trigger) throw new Error('trigger missing');
  trigger.focus();
  await act(async () => {
    trigger.click();
  });
  await waitFor(() => sheet() !== null, 'sheet');
  return trigger;
}

beforeEach(async () => {
  closed = 0;
  await db.delete();
  await db.open();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Harness />);
  });
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

describe('WhatsNew', () => {
  it('is a labelled modal that lists the running version’s notes', async () => {
    await openSheet();

    const dialog = sheet();
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog?.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(dialog?.querySelector(`#${labelledBy}`)?.textContent).toBe('What’s new in 0.3.0');

    // Straight from CHANGELOG.md, without any markdown rendering.
    const groups = [...(dialog?.querySelectorAll('.whatsnew-group-title') ?? [])].map((node) => node.textContent);
    expect(groups).toEqual(['Fixed — your data', 'Fixed — listening', 'New', 'Known limits']);
    const bullets = changelogSection('0.3.0')?.groups.reduce((n, group) => n + group.bullets.length, 0);
    expect(dialog?.querySelectorAll('.whatsnew-list li')).toHaveLength(bullets ?? -1);
    expect(dialog?.textContent).toContain('Restoring a backup failed');
    expect(dialog?.innerHTML).not.toContain('**');
    expect(dialog?.querySelector('.whatsnew-list strong')).toBeNull();
  });

  it('moves focus to "Got it" when it opens', async () => {
    await openSheet();
    expect(document.activeElement).toBe(sheetButton('Got it'));
  });

  it('closes on Escape, records the version and returns focus to the trigger', async () => {
    const trigger = await openSheet();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    });
    await waitFor(() => sheet() === null, 'sheet closed');

    expect(closed).toBe(1);
    expect(document.activeElement).toBe(trigger);
    expect(await getSetting('app.lastSeenVersion', undefined)).toBe('0.3.0');
  });

  it('closes on "Got it" and records the version', async () => {
    await openSheet();

    await act(async () => {
      sheetButton('Got it')?.click();
    });
    await waitFor(() => sheet() === null, 'sheet closed');

    expect(closed).toBe(1);
    expect(await getSetting('app.lastSeenVersion', undefined)).toBe('0.3.0');
  });

  it('closes when the backdrop is tapped', async () => {
    await openSheet();

    await act(async () => {
      container.querySelector<HTMLElement>('.sheet-backdrop')?.click();
    });
    await waitFor(() => sheet() === null, 'sheet closed');
    expect(await getSetting('app.lastSeenVersion', undefined)).toBe('0.3.0');
  });

  it('closes on the Android back key', async () => {
    await openSheet();
    const navigate = vi.fn();
    const dispose = installBackBridge(navigate, () => '/');

    try {
      await act(async () => {
        window.__pharmaBack?.();
      });
      await waitFor(() => sheet() === null, 'sheet closed');
      expect(navigate).not.toHaveBeenCalled();
      expect(closed).toBe(1);
    } finally {
      dispose();
    }
  });

  it('offers to turn the update check on, then stops asking', async () => {
    await openSheet();

    const tellMe = sheetButton('Tell me about updates');
    expect(tellMe?.className).toContain('btn-secondary');

    await act(async () => {
      tellMe?.click();
    });
    await waitFor(() => sheetButton('Tell me about updates') === undefined, 'offer to disappear');
    await waitFor(
      () => container.querySelector('.whatsnew-note') !== null,
      'confirmation line',
    );

    expect(container.querySelector('.whatsnew-note')?.textContent).toContain('Update checks are on');
    expect(await getSetting('app.updateCheck', false)).toBe(true);
    expect(sheetButton('Got it')?.className).toContain('btn-primary');
  });

  it('does not offer the update check again once it is already on', async () => {
    await db.settings.put({ key: 'app.updateCheck', value: true });
    await openSheet();

    await waitFor(() => sheet() !== null, 'sheet');
    await waitFor(
      () => sheetButton('Tell me about updates') === undefined,
      'the offer to stay hidden',
    );
    expect(sheetButton('Got it')).toBeTruthy();
    expect(container.querySelector('.whatsnew-note')).toBeNull();
  });
});
