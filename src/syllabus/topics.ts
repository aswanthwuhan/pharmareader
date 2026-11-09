import { db } from '../core/db';
import type { Topic } from '../core/types';
import { LEVELS } from './defaults';

export { LEVELS };

export const LEVEL_LABEL: Record<Topic['level'], string> = {
  basic: 'Basic',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
};

export interface TopicNode extends Topic {
  children: TopicNode[];
}

/** Topics arrive unsorted from IndexedDB; this is the single place that fixes the shape for rendering. */
export function buildTopicTree(topics: Topic[]): TopicNode[] {
  const nodes = new Map<string, TopicNode>();
  for (const t of topics) nodes.set(t.id, { ...t, children: [] });

  const roots: TopicNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId === null ? undefined : nodes.get(node.parentId);
    // An orphan (parent deleted mid-edit) is shown at the root rather than hidden.
    (parent ? parent.children : roots).push(node);
  }

  const sort = (list: TopicNode[]) => {
    list.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
    for (const node of list) sort(node.children);
  };
  sort(roots);
  return roots;
}

/** Every id in the subtree rooted at `rootId`, including the root itself. */
export function subtreeIds(rootId: string, topics: Topic[]): string[] {
  const children = new Map<string, string[]>();
  for (const t of topics) {
    if (t.parentId === null) continue;
    const list = children.get(t.parentId);
    if (list) list.push(t.id);
    else children.set(t.parentId, [t.id]);
  }

  const out = [rootId];
  const seen = new Set(out);
  for (let i = 0; i < out.length; i += 1) {
    for (const child of children.get(out[i] as string) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
    }
  }
  return out;
}

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'topic';
}

async function uniqueTopicId(title: string): Promise<string> {
  const base = slugify(title);
  let id = base;
  for (let n = 2; await db.topics.get(id); n += 1) id = `${base}-${n}`;
  return id;
}

export async function siblingsOf(parentId: string | null): Promise<Topic[]> {
  const list =
    parentId === null
      ? await db.topics.filter((t) => t.parentId === null).toArray()
      : await db.topics.where('parentId').equals(parentId).toArray();
  return list.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

export async function addSubtopic(
  parentId: string | null,
  title: string,
  level: Topic['level'] = 'basic',
): Promise<string> {
  const clean = title.trim();
  const id = await uniqueTopicId(clean || 'Untitled topic');
  const order = (await siblingsOf(parentId)).reduce((max, t) => Math.max(max, t.order), 0) + 1;
  await db.topics.put({
    id,
    parentId,
    title: clean || 'Untitled topic',
    level,
    order,
    custom: true,
  });
  return id;
}

export async function renameTopic(id: string, title: string): Promise<void> {
  const clean = title.trim();
  if (!clean) return;
  await db.topics.update(id, { title: clean });
}

export async function setTopicLevel(id: string, level: Topic['level']): Promise<void> {
  if (!LEVELS.includes(level)) return;
  await db.topics.update(id, { level });
}

/** Deletes the topic and everything under it; tagged books keep their (now unknown) ids harmlessly. */
export async function deleteTopic(id: string): Promise<void> {
  const all = await db.topics.toArray();
  const doomed = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of all) {
      if (t.parentId !== null && doomed.has(t.parentId) && !doomed.has(t.id)) {
        doomed.add(t.id);
        grew = true;
      }
    }
  }
  await db.topics.bulkDelete([...doomed]);
}

/** Swaps a topic with its previous (-1) or next (+1) sibling. */
export async function moveTopic(id: string, delta: -1 | 1): Promise<void> {
  const topic = await db.topics.get(id);
  if (!topic) return;
  const siblings = await siblingsOf(topic.parentId);
  const i = siblings.findIndex((t) => t.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= siblings.length) return;

  const reordered = siblings.map((t, k) => ({ ...t, order: k + 1 }));
  const a = reordered[i] as Topic;
  const b = reordered[j] as Topic;
  reordered[i] = { ...b, order: a.order };
  reordered[j] = { ...a, order: b.order };
  await db.topics.bulkPut(reordered);
}

/** Renumbers each sibling group 1..n, keeping relative order (used after reset). */
export async function normalizeOrders(): Promise<void> {
  const all = await db.topics.toArray();
  const groups = new Map<string, Topic[]>();
  for (const t of all) {
    const key = t.parentId ?? '';
    const group = groups.get(key);
    if (group) group.push(t);
    else groups.set(key, [t]);
  }

  const changed: Topic[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
    group.forEach((t, i) => {
      if (t.order !== i + 1) changed.push({ ...t, order: i + 1 });
    });
  }
  if (changed.length > 0) await db.topics.bulkPut(changed);
}
