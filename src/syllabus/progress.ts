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

function collectSubtree(rootId: string, children: Map<string, string[]>): string[] {
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

/**
 * Progress for every topic in one pass, children rolled up into their parents.
 * Book/highlight counts are index-only lookups (the records themselves are large:
 * a book carries its parsed text and file), cards are read whole because maturity
 * lives inside `fsrs`.
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
  const bookSets = new Map(ids.map((id, i) => [id, new Set(bookKeys[i] ?? [])]));
  const highlightSets = new Map(ids.map((id, i) => [id, new Set(highlightKeys[i] ?? [])]));

  const cardsByTopic = new Map<string, Set<string>>();
  const cardById = new Map<string, CardRecord>();
  for (const card of cards) {
    cardById.set(card.id, card);
    for (const id of card.topicIds ?? []) {
      const set = cardsByTopic.get(id);
      if (set) set.add(card.id);
      else cardsByTopic.set(id, new Set([card.id]));
    }
  }

  const reviewedToday = new Set(todaysLogs.map((log) => log.cardId));
  const children = childrenMap(topics);
  const progress = new Map<string, TopicProgress>();

  for (const topic of topics) {
    const books = new Set<string>();
    const highlights = new Set<string>();
    const cardIds = new Set<string>();
    for (const id of collectSubtree(topic.id, children)) {
      for (const key of bookSets.get(id) ?? []) books.add(key);
      for (const key of highlightSets.get(id) ?? []) highlights.add(key);
      for (const key of cardsByTopic.get(id) ?? []) cardIds.add(key);
    }

    let mature = 0;
    let reviewed = 0;
    for (const cardId of cardIds) {
      const card = cardById.get(cardId);
      if (card && isMatureCard(card)) mature += 1;
      if (reviewedToday.has(cardId)) reviewed += 1;
    }
    progress.set(topic.id, { books: books.size, highlights: highlights.size, cards: cardIds.size, mature, reviewedToday: reviewed });
  }
  return progress;
}

/** Progress for one topic, including all of its descendants. */
export async function topicProgress(topicId: string): Promise<TopicProgress> {
  const all = await topicProgressAll();
  return all.get(topicId) ?? EMPTY_PROGRESS;
}
