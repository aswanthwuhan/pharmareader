import { db } from '../core/db';
import type { CardRecord, Topic } from '../core/types';

export interface TopicProgress {
  books: number;
  highlights: number;
  cards: number;
  /** Cards with FSRS stability >= 21 days (or a Review card scheduled >= 21 days out). */
  mature: number;
  /** Distinct cards of this topic reviewed since local midnight. */
  reviewedToday: number;
}

export const EMPTY_PROGRESS: TopicProgress = { books: 0, highlights: 0, cards: 0, mature: 0, reviewedToday: 0 };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  let current = value;
  if (typeof current === 'string') {
    try {
      current = JSON.parse(current) as unknown;
    } catch {
      return undefined;
    }
  }
  return typeof current === 'object' && current !== null ? (current as Record<string, unknown>) : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * `CardRecord.fsrs` is opaque storage (ts-fsrs Card, possibly rehydrated from a
 * backup), so every field is read defensively and simply ignored when absent.
 */
export function isMatureCard(card: Pick<CardRecord, 'fsrs'>): boolean {
  const fsrs = asRecord(card.fsrs);
  if (!fsrs) return false;

  const stability = numberOf(fsrs.stability);
  if (stability !== undefined && stability >= 21) return true;

  const scheduled = numberOf(fsrs.scheduled_days) ?? numberOf(fsrs.scheduledDays);
  const state = fsrs.state;
  const isReview = state === 2 || (typeof state === 'string' && state.toLowerCase() === 'review');
  return isReview && scheduled !== undefined && scheduled >= 21;
}

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function childrenMap(topics: Topic[]): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const t of topics) {
    if (t.parentId === null) continue;
    const list = children.get(t.parentId);
    if (list) list.push(t.id);
    else children.set(t.parentId, [t.id]);
  }
  return children;
}

interface DirectProgress {
  books: Set<string>;
  highlights: Set<string>;
  cards: Set<string>;
}

function emptyDirect(): DirectProgress {
  return { books: new Set(), highlights: new Set(), cards: new Set() };
}

/** Depth of each topic (roots = 0). Cycles, which should not exist, are cut defensively. */
function depths(topics: Topic[]): Map<string, number> {
  const byId = new Map(topics.map((t) => [t.id, t]));
  const depth = new Map<string, number>();
  for (const topic of topics) {
    let current: Topic | undefined = topic;
    let d = 0;
    while (current && current.parentId !== null && d <= topics.length) {
      d += 1;
      current = byId.get(current.parentId);
    }
    depth.set(topic.id, Math.min(d, topics.length));
  }
  return depth;
}

/**
 * Progress for every topic in one pass, children rolled up into their parents.
 * Book/highlight counts are index-only lookups (the records themselves are large:
 * a book carries its parsed text and file), cards are read whole because maturity
 * lives inside `fsrs`.
 *
 * Roll-up is bottom-up: each topic starts with what is tagged directly on it and
 * then unions in its children's already-merged sets. Because every set is keyed by
 * record id, a book/highlight/card tagged on both a parent and one of its children
 * is counted once, never twice.
 */
export async function topicProgressAll(): Promise<Map<string, TopicProgress>> {
  const [topics, cards, todaysLogs] = await Promise.all([
    db.topics.toArray(),
    db.cards.toArray(),
    db.reviewLogs.where('reviewedAt').aboveOrEqual(startOfToday()).toArray(),
  ]);
  const ids = topics.map((t) => t.id);

  const [bookKeys, highlightKeys] = await Promise.all([
    Promise.all(ids.map((id) => db.books.where('topicIds').equals(id).primaryKeys())),
    Promise.all(ids.map((id) => db.highlights.where('topicIds').equals(id).primaryKeys())),
  ]);

  const direct = new Map<string, DirectProgress>();
  const at = (id: string): DirectProgress => {
    const existing = direct.get(id);
    if (existing) return existing;
    const created = emptyDirect();
    direct.set(id, created);
    return created;
  };
  ids.forEach((id, i) => {
    const entry = at(id);
    for (const key of bookKeys[i] ?? []) entry.books.add(key);
    for (const key of highlightKeys[i] ?? []) entry.highlights.add(key);
  });

  const cardById = new Map<string, CardRecord>();
  for (const card of cards) {
    cardById.set(card.id, card);
    for (const id of card.topicIds ?? []) at(id).cards.add(card.id);
  }

  const children = childrenMap(topics);
  const depth = depths(topics);
  const order = [...ids].sort((a, b) => (depth.get(b) ?? 0) - (depth.get(a) ?? 0));

  for (const id of order) {
    const parent = direct.get(id) ?? emptyDirect();
    direct.set(id, parent);
    for (const childId of children.get(id) ?? []) {
      const child = direct.get(childId);
      if (!child) continue;
      for (const key of child.books) parent.books.add(key);
      for (const key of child.highlights) parent.highlights.add(key);
      for (const key of child.cards) parent.cards.add(key);
    }
  }

  const reviewedToday = new Set(todaysLogs.map((log) => log.cardId));
  const progress = new Map<string, TopicProgress>();
  for (const topic of topics) {
    const entry = direct.get(topic.id) ?? emptyDirect();
    let mature = 0;
    let reviewed = 0;
    for (const cardId of entry.cards) {
      const card = cardById.get(cardId);
      if (card && isMatureCard(card)) mature += 1;
      if (reviewedToday.has(cardId)) reviewed += 1;
    }
    progress.set(topic.id, {
      books: entry.books.size,
      highlights: entry.highlights.size,
      cards: entry.cards.size,
      mature,
      reviewedToday: reviewed,
    });
  }
  return progress;
}

/** Progress for one topic, including all of its descendants. */
export async function topicProgress(topicId: string): Promise<TopicProgress> {
  const all = await topicProgressAll();
  return all.get(topicId) ?? EMPTY_PROGRESS;
}
