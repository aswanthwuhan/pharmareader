import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../core/db';
import type { Topic } from '../core/types';
import {
  addSubtopic,
  buildTopicTree,
  deleteTopic,
  moveTopic,
  normalizeOrders,
  renameTopic,
  setTopicLevel,
  siblingsOf,
  slugify,
  subtreeIds,
} from './topics';

const topic = (id: string, parentId: string | null, order: number, title = id): Topic => ({
  id,
  parentId,
  title,
  level: 'basic',
  order,
});

afterEach(async () => {
  await db.delete();
  await db.open();
});

describe('buildTopicTree', () => {
  it('groups children under parents and sorts by order then title', () => {
    const tree = buildTopicTree([
      topic('b', null, 2, 'B'),
      topic('a', null, 1, 'A'),
      topic('a2', 'a', 2, 'Second'),
      topic('a1', 'a', 1, 'First'),
    ]);
    expect(tree.map((n) => n.id)).toEqual(['a', 'b']);
    expect(tree[0]?.children.map((n) => n.id)).toEqual(['a1', 'a2']);
  });

  it('shows orphans at the root instead of hiding them', () => {
    const tree = buildTopicTree([topic('root', null, 1), topic('lost', 'deleted-parent', 2)]);
    expect(tree.map((n) => n.id).sort()).toEqual(['lost', 'root']);
  });

  it('keeps every topic exactly once', () => {
    const topics = [topic('r', null, 1), topic('c1', 'r', 1), topic('c2', 'r', 2), topic('g', 'c1', 1)];
    const count = (nodes: ReturnType<typeof buildTopicTree>): number =>
      nodes.reduce((n, node) => n + 1 + count(node.children), 0);
    expect(count(buildTopicTree(topics))).toBe(4);
  });
});

describe('subtreeIds', () => {
  it('returns the whole subtree in BFS order', () => {
    const topics = [topic('r', null, 1), topic('c1', 'r', 1), topic('c2', 'r', 2), topic('g', 'c1', 1)];
    expect(subtreeIds('r', topics)).toEqual(['r', 'c1', 'c2', 'g']);
    expect(subtreeIds('c1', topics)).toEqual(['c1', 'g']);
    expect(subtreeIds('missing', topics)).toEqual(['missing']);
  });
});

describe('addSubtopic', () => {
  it('slugifies ids and appends a suffix on collision', async () => {
    const first = await addSubtopic(null, 'Adverse Drug Reactions');
    const second = await addSubtopic(null, 'Adverse  Drug Reactions');
    expect(first).toBe('adverse-drug-reactions');
    expect(second).toBe('adverse-drug-reactions-2');
    expect(slugify('  Beta-lactams & Aminoglycosides! ')).toBe('beta-lactams-aminoglycosides');
  });

  it('orders new topics after existing siblings and marks them custom', async () => {
    await db.topics.bulkPut([topic('a', null, 1), topic('b', null, 5)]);
    const id = await addSubtopic(null, 'C');
    const siblings = await siblingsOf(null);
    expect(siblings.map((t) => t.id)).toEqual(['a', 'b', id]);
    expect((await db.topics.get(id))?.custom).toBe(true);
    expect((await db.topics.get(id))?.order).toBe(6);
  });
});

describe('deleteTopic', () => {
  it('deletes the whole subtree and nothing else', async () => {
    await db.topics.bulkPut([
      topic('root', null, 1),
      topic('child', 'root', 1),
      topic('grandchild', 'child', 1),
      topic('sibling', null, 2),
    ]);

    await deleteTopic('child');

    expect(await db.topics.orderBy('id').keys()).toEqual(['root', 'sibling']);
  });

  it('is a no-op for an unknown id', async () => {
    await db.topics.put(topic('root', null, 1));
    await deleteTopic('missing');
    expect(await db.topics.count()).toBe(1);
  });
});

describe('moveTopic', () => {
  it('swaps order with the previous and next sibling', async () => {
    await db.topics.bulkPut([topic('a', null, 1), topic('b', null, 2), topic('c', null, 3)]);

    await moveTopic('b', -1);
    expect((await siblingsOf(null)).map((t) => t.id)).toEqual(['b', 'a', 'c']);

    await moveTopic('b', 1);
    expect((await siblingsOf(null)).map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('does nothing at the edges', async () => {
    await db.topics.bulkPut([topic('a', null, 1), topic('b', null, 2)]);
    await moveTopic('a', -1);
    await moveTopic('b', 1);
    expect((await siblingsOf(null)).map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('only reorders within the same parent', async () => {
    await db.topics.bulkPut([
      topic('p1', null, 1),
      topic('p2', null, 2),
      topic('c1', 'p1', 1),
      topic('c2', 'p1', 2),
    ]);
    await moveTopic('c2', -1);
    expect((await siblingsOf('p1')).map((t) => t.id)).toEqual(['c2', 'c1']);
    expect((await siblingsOf(null)).map((t) => t.id)).toEqual(['p1', 'p2']);
  });

  it('normalises duplicate or gapped orders while swapping', async () => {
    await db.topics.bulkPut([topic('a', null, 10), topic('b', null, 20), topic('c', null, 99)]);
    await moveTopic('c', -1);
    expect((await siblingsOf(null)).map((t) => [t.id, t.order])).toEqual([
      ['a', 1],
      ['c', 2],
      ['b', 3],
    ]);
  });
});

describe('normalizeOrders and simple updates', () => {
  it('renumbers each sibling group independently', async () => {
    await db.topics.bulkPut([
      topic('p1', null, 4),
      topic('p2', null, 9),
      topic('c1', 'p1', 7),
      topic('c2', 'p1', 8),
    ]);
    await normalizeOrders();
    expect((await siblingsOf(null)).map((t) => t.order)).toEqual([1, 2]);
    expect((await siblingsOf('p1')).map((t) => t.order)).toEqual([1, 2]);
  });

  it('renames, ignores blank titles and rejects unknown levels', async () => {
    await db.topics.put(topic('a', null, 1));
    await renameTopic('a', '  Renamed  ');
    expect((await db.topics.get('a'))?.title).toBe('Renamed');
    await renameTopic('a', '   ');
    expect((await db.topics.get('a'))?.title).toBe('Renamed');
    await setTopicLevel('a', 'advanced');
    expect((await db.topics.get('a'))?.level).toBe('advanced');
    await setTopicLevel('a', 'expert' as never);
    expect((await db.topics.get('a'))?.level).toBe('advanced');
  });
});
