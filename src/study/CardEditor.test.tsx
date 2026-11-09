import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../core/db';
import CardEditor from './CardEditor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  await db.delete();
  await db.open();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  await db.delete();
});

describe('CardEditor', () => {
  it('gives each mounted editor its own field ids so labels stay attached', async () => {
    await act(async () => {
      root.render(
        createElement(
          'div',
          null,
          createElement(CardEditor, { onSave: () => {}, onCancel: () => {} }),
          createElement(CardEditor, { onSave: () => {}, onCancel: () => {} }),
        ),
      );
    });

    const ids = [...container.querySelectorAll<HTMLElement>('[id]')].map((element) => element.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);

    for (const label of container.querySelectorAll<HTMLLabelElement>('label[for]')) {
      const target = container.querySelector(`#${CSS.escape(label.htmlFor)}`);
      expect(target, `label for ${label.htmlFor} has no field`).not.toBeNull();
    }
  });
});
