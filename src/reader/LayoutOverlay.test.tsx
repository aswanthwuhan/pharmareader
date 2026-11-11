import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Block } from '../core/types';
import type { PageBlock } from './blockOrder';
import LayoutOverlay from './LayoutOverlay';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function pageBlock(
  blockId: string,
  order: number,
  kind: Block['kind'] = 'p',
  box = { x: 10, y: 10 * order, w: 90, h: 10 }
): PageBlock {
  return { chapterIndex: 0, blockIndex: order - 1, blockId, kind, order, box };
}

const THREE = [pageBlock('a', 1), pageBlock('b', 2, 'h'), pageBlock('c', 3, 'figure')];

let container: HTMLDivElement;
let root: Root | null = null;

async function renderOverlay(
  blocks: PageBlock[] = THREE,
  onSave: (ids: string[]) => Promise<void> = async () => undefined,
  scale = 1
): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await rerenderOverlay(blocks, onSave, scale);
}

async function rerenderOverlay(
  blocks: PageBlock[] = THREE,
  onSave: (ids: string[]) => Promise<void> = async () => undefined,
  scale = 1
): Promise<void> {
  await act(async () => {
    root?.render(<LayoutOverlay blocks={blocks} scale={scale} onSave={onSave} />);
  });
}

async function click(target: Element | null): Promise<void> {
  if (!target) throw new Error('nothing to click');
  await act(async () => {
    (target as HTMLElement).click();
  });
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  );
  if (!found) throw new Error(`no button "${label}"`);
  return found as HTMLButtonElement;
}

function boxes(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-block-id]'));
}

function orderOf(blockId: string): string | null {
  return container.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`)?.dataset.order ?? null;
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}

afterEach(() => {
  vi.restoreAllMocks();
  act(() => {
    root?.unmount();
  });
  root = null;
  container.remove();
});

describe('LayoutOverlay view mode', () => {
  it('draws one numbered box per block, at the rendered page scale', async () => {
    await renderOverlay([pageBlock('a', 1, 'p', { x: 10, y: 20, w: 100, h: 30 })], async () => undefined, 2);

    const [box] = boxes();
    expect(boxes()).toHaveLength(1);
    expect(box.style.left).toBe('20px');
    expect(box.style.top).toBe('40px');
    expect(box.style.width).toBe('200px');
    expect(box.style.height).toBe('60px');
    expect(box.dataset.order).toBe('1');
    expect(box.textContent).toBe('1');
    // The boxes must let a swipe or a tap through to the page underneath.
    expect(box.getAttribute('aria-hidden')).toBe('true');
    expect(box.tagName).toBe('DIV');
  });

  it('numbers the blocks in the stored reading order', async () => {
    await renderOverlay();
    expect(boxes().map((box) => [box.dataset.blockId, box.dataset.order])).toEqual([
      ['a', '1'],
      ['b', '2'],
      ['c', '3'],
    ]);
  });

  it('offers fix mode and says what re-analysing does', async () => {
    await renderOverlay();
    expect(button('Fix order')).toBeTruthy();
    expect(container.textContent).toContain('Re-analysing this book replaces manual order.');
    // No save control before there is anything to save.
    expect(container.textContent).not.toContain('Save');
  });

  it('has nothing to fix on a page without blocks', async () => {
    await renderOverlay([]);
    expect(container.textContent).toContain('No text blocks detected on this page.');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('mounts the bar in the host PdfView gives it, under the page', async () => {
    container = document.createElement('div');
    document.body.append(container);
    const host = document.createElement('div');
    container.append(host);
    root = createRoot(container);
    await act(async () => {
      root?.render(<LayoutOverlay blocks={THREE} scale={1} onSave={async () => undefined} panelHost={host} />);
    });

    // The bar is out of the page box, with the boxes still inside it.
    expect(host.textContent).toContain('Re-analysing this book replaces manual order.');
    expect(host.textContent).toContain('Fix order');
    expect(boxes()).toHaveLength(3);
    expect(container.lastElementChild?.textContent).not.toContain('Fix order');
  });
});

describe('LayoutOverlay fix mode', () => {
  async function startFixing(onSave?: (ids: string[]) => Promise<void>): Promise<void> {
    await renderOverlay(THREE, onSave);
    await click(button('Fix order'));
  }

  it('turns every block into a labelled tap target', async () => {
    await startFixing();
    expect(boxes().map((box) => box.tagName)).toEqual(['BUTTON', 'BUTTON', 'BUTTON']);
    expect(container.querySelector<HTMLElement>('[data-block-id="a"]')?.getAttribute('aria-label')).toBe(
      'Body text block, not tapped yet'
    );
    // Untapped blocks carry no number yet.
    expect(orderOf('a')).toBeNull();
    // "Fix order" unmounted with the mode change, so focus has to land on the
    // first block instead of falling back to the document.
    expect(document.activeElement).toBe(boxes()[0]);
  });

  it('numbers the blocks in the order they are tapped', async () => {
    await startFixing();
    const target = (id: string): HTMLElement | null => container.querySelector<HTMLElement>(`[data-block-id="${id}"]`);

    await click(target('c'));
    await click(target('a'));
    expect([orderOf('c'), orderOf('a'), orderOf('b')]).toEqual(['1', '2', null]);
    expect(container.querySelector<HTMLElement>('[data-block-id="a"]')?.getAttribute('aria-label')).toBe(
      'Body text block, position 2 in the new order'
    );
    expect(container.textContent).toContain('2 of 3 tapped — the rest follow in their current order.');
    // A second tap on one block says the same thing again, it does not number it twice.
    await click(target('c'));
    expect([orderOf('c'), orderOf('a')]).toEqual(['1', '2']);
  });

  it('keeps Save off until something is tapped', async () => {
    await startFixing();
    expect(button('Save').disabled).toBe(true);
    await click(container.querySelector('[data-block-id="b"]'));
    expect(button('Save').disabled).toBe(false);
  });

  it('undoes the last tap, one at a time', async () => {
    await startFixing();
    const target = (id: string): HTMLElement | null => container.querySelector<HTMLElement>(`[data-block-id="${id}"]`);
    await click(target('b'));
    await click(target('c'));
    await click(button('Undo last'));

    expect([orderOf('b'), orderOf('c')]).toEqual(['1', null]);
    await click(button('Undo last'));
    expect([orderOf('b'), orderOf('c')]).toEqual([null, null]);
    expect(button('Undo last').disabled).toBe(true);
  });

  it('cancel drops the taps and leaves the order alone', async () => {
    const onSave = vi.fn(async () => undefined);
    await startFixing(onSave);
    await click(container.querySelector('[data-block-id="c"]'));
    await click(button('Cancel'));

    expect(onSave).not.toHaveBeenCalled();
    expect(boxes().map((box) => [box.dataset.blockId, box.dataset.order])).toEqual([
      ['a', '1'],
      ['b', '2'],
      ['c', '3'],
    ]);
    expect(button('Fix order')).toBeTruthy();
    // And the control that started fix mode gets the focus back.
    expect(document.activeElement).toBe(button('Fix order'));
  });

  it('saves the tapped ids first and the rest in their current order', async () => {
    const onSave = vi.fn(async () => undefined);
    await startFixing(onSave);
    await click(container.querySelector('[data-block-id="c"]'));
    await click(container.querySelector('[data-block-id="b"]'));
    await click(button('Save'));

    expect(onSave).toHaveBeenCalledWith(['c', 'b', 'a']);
    await waitFor(() => button('Fix order') !== null, 'fix mode to close');
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('saves an order for every block once the last one is tapped', async () => {
    const onSave = vi.fn(async () => undefined);
    await startFixing(onSave);
    await click(container.querySelector('[data-block-id="b"]'));
    await click(container.querySelector('[data-block-id="a"]'));
    await click(container.querySelector('[data-block-id="c"]'));
    await click(button('Save'));

    expect(onSave).toHaveBeenCalledWith(['b', 'a', 'c']);
  });

  it('stays open with the taps kept when the save fails', async () => {
    const onSave = vi.fn(async () => {
      throw new Error('offline');
    });
    await renderOverlay(THREE, onSave);
    await click(button('Fix order'));
    await click(container.querySelector('[data-block-id="b"]'));
    await click(button('Save'));

    await waitFor(() => (container.textContent ?? '').includes('Could not save the order.'), 'the error message');
    expect(orderOf('b')).toBe('1');
    expect(button('Save').disabled).toBe(false);
  });

  it('starts over on another page', async () => {
    await startFixing();
    await click(container.querySelector('[data-block-id="b"]'));
    await rerenderOverlay([pageBlock('d', 1)], async () => undefined);

    expect(container.querySelectorAll('button')).toHaveLength(1);
    expect(button('Fix order')).toBeTruthy();
    expect(orderOf('d')).toBe('1');
  });
});
