import { afterEach, describe, expect, it, vi } from 'vitest';
import { installBackBridge, pushBackHandler } from './backButton';

const disposers: Array<() => void> = [];

afterEach(() => {
  // Drain newest first: a leaked handler would otherwise answer the next test's press.
  while (disposers.length > 0) disposers.pop()?.();
});

function press(): boolean {
  return window.__pharmaBack ? window.__pharmaBack() : false;
}

function bridge(path: string) {
  const navigate = vi.fn();
  const dispose = installBackBridge(navigate, () => path);
  disposers.push(dispose);
  return { navigate, dispose };
}

describe('pushBackHandler', () => {
  it('offers the press to the newest handler first and stops at the first one that handles it', () => {
    const calls: string[] = [];
    disposers.push(
      pushBackHandler(() => {
        calls.push('older');
        return true;
      }),
    );
    disposers.push(
      pushBackHandler(() => {
        calls.push('newer');
        return false;
      }),
    );
    const { navigate } = bridge('/read/book-1');

    expect(press()).toBe(true);
    expect(calls).toEqual(['newer', 'older']);
    // A handler handled it, so the library fallback stays out of the way.
    expect(navigate).not.toHaveBeenCalled();
  });

  it('stops before older handlers once a handler handles the press', () => {
    const older = vi.fn(() => true);
    const newer = vi.fn(() => true);
    disposers.push(pushBackHandler(older), pushBackHandler(newer));
    bridge('/read/book-1');

    expect(press()).toBe(true);
    expect(newer).toHaveBeenCalledTimes(1);
    expect(older).not.toHaveBeenCalled();
  });

  it('unregisters without disturbing the other handlers, and twice is harmless', () => {
    const keep = vi.fn(() => true);
    const drop = vi.fn(() => false);
    const offKeep = pushBackHandler(keep);
    const offDrop = pushBackHandler(drop);
    disposers.push(offKeep, offDrop);
    bridge('/review');

    offDrop();
    offDrop();
    expect(press()).toBe(true);
    expect(keep).toHaveBeenCalledTimes(1);
    expect(drop).not.toHaveBeenCalled();
  });
});

describe('installBackBridge', () => {
  it('steps from any screen back to the library when nothing handles the press', () => {
    const { navigate } = bridge('/read/book-1');
    disposers.push(pushBackHandler(() => false));

    expect(press()).toBe(true);
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('returns false on the library itself so the shell can ask about exiting', () => {
    const { navigate } = bridge('/');

    expect(press()).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('lets a handler handle the press even on the library', () => {
    const { navigate } = bridge('/');
    disposers.push(pushBackHandler(() => true));

    expect(press()).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('installs window.__pharmaBack and restores the previous bridge on dispose', () => {
    const previous = vi.fn(() => true);
    window.__pharmaBack = previous;
    const { dispose } = bridge('/');
    disposers.length = 0;

    expect(window.__pharmaBack).not.toBe(previous);
    dispose();
    expect(window.__pharmaBack).toBe(previous);
    delete window.__pharmaBack;
  });
});
