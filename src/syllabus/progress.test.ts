import { afterEach, describe, expect, it } from 'vitest';
import { db, newId } from '../core/db';
import type { BookRecord, CardRecord, Topic } from '../core/types';
import { EMPTY_PROGRESS, isMatureCard, topicProgress, topicProgressAll } from './progress';

const topic = (id: string, parentId: string | null, order = 1): Topic => ({ id, parentId, title: id, level: 'basic', order });

const book = (topicIds: string[]): BookRecord => ({
  id: newId(),
  title: `Book ${topicIds.join('+')}`,
  format: 'txt',
  addedAt: Date.now(),
  fileBlob: new Blob(['sample']),
  parsed: { title: 'Sample', format: 'txt', chapters: [] },
  topicIds,
});

const card = (topicIds: string[], fsrs: unknown): CardRecord => ({
  id: newId(),
  kind: 'qa',
  front: 'front',
  back: 'back',
  topicIds,
  fsrs,
  createdAt: Date.now(),
});

afterEach(async () => {
  await db.delete();
  await db.open();
});

describe('isMatureCard', () => {
  it('uses stability first', () => {
    expect(isMatureCard({ fsrs: { stability: 21 } })).toBe(true);
    expect(isMatureCard({ fsrs: { stability: 30.5, state: 3 } })).toBe(true);
    expect(isMatureCard({ fsrs: { stability: 20.9 } })).toBe(false);
  });

  it('falls back to a Review card scheduled 21+ days out', () => {
    expect(isMatureCard({ fsrs: { state: 2, scheduled_days: 21 } })).toBe(true);
    expect(isMatureCard({ fsrs: { state: 'Review', scheduled_days: 40 } })).toBe(true);
    expect(isMatureCard({ fsrs: { state: 2, scheduled_days: 20 } })).toBe(false);
    expect(isMatureCard({ fsrs: { state: 1, scheduled_days: 40 } })).toBe(false);
  });

  it('survives unknown or malformed fsrs payloads', () => {
    expect(isMatureCard({ fsrs: '{"stability":30}' })).toBe(true);
    expect(isMatureCard({ fsrs: 'not json' })).toBe(false);
    expect(isMatureCard({ fsrs: null })).toBe(false);
    expect(isMatureCard({ fsrs: {} })).toBe(false);
    expect(isMatureCard({ fsrs: 42 })).toBe(false);
  });
});

describe('topicProgress', () => {
  it('rolls children into the parent and counts distinct records', async () => {
    await db.topics.bulkPut([topic('parent', null), topic('child', 'parent'), topic('other', null)]);
    const parentBook = book(['parent']);
    const childBook = book(['child']);
    await db.books.bulkPut([parentBook, childBook]);
    await db.highlights.put({
      id: newId(),
      bookId: childBook.id,
      sentenceIds: ['s1'],
      text: 'Bioavailability',
      color: 'yellow',
      topicIds: ['child'],
      createdAt: Date.now(),
    });

    const mature = card(['child'], { stability: 40, state: 2, scheduled_days: 45 });
    const learning = card(['parent'], { stability: 2.5, state: 1, scheduled_days: 1 });
    const legacy = card(['child'], '{"stability":1,"state":"Learning"}');
    await db.cards.bulkPut([mature, learning, legacy]);

    const day = 86_400_000;
    await db.reviewLogs.bulkPut([
      { id: newId(), cardId: mature.id, rating: 3, reviewedAt: Date.now(), log: {} },
      { id: newId(), cardId: mature.id, rating: 4, reviewedAt: Date.now(), log: {} },
      { id: newId(), cardId: learning.id, rating: 1, reviewedAt: Date.now() - 3 * day, log: {} },
    ]);

    const all = await topicProgressAll();
    expect(all.get('parent')).toEqual({ books: 2, highlights: 1, cards: 3, mature: 1, reviewedToday: 1 });
    expect(all.get('child')).toEqual({ books: 1, highlights: 1, cards: 2, mature: 1, reviewedToday: 1 });
    expect(all.get('other')).toEqual(EMPTY_PROGRESS);

    expect(await topicProgress('parent')).toEqual({ books: 2, highlights: 1, cards: 3, mature: 1, reviewedToday: 1 });
    expect(await topicProgress('missing')).toEqual(EMPTY_PROGRESS);
  });

  it('counts a book once even when it is tagged to parent and child', async () => {
    await db.topics.bulkPut([topic('parent', null), topic('child', 'parent')]);
    await db.books.put(book(['parent', 'child']));

    expect((await topicProgress('parent')).books).toBe(1);
    expect((await topicProgress('child')).books).toBe(1);
  });

  it('counts a card once when it is tagged to parent and child', async () => {
    await db.topics.bulkPut([topic('parent', null), topic('child', 'parent')]);
    const shared = card(['parent', 'child'], { stability: 40, state: 2, scheduled_days: 45 });
    await db.cards.put(shared);
    await db.reviewLogs.put({ id: newId(), cardId: shared.id, rating: 3, reviewedAt: Date.now(), log: {} });

    const all = await topicProgressAll();
    expect(all.get('parent')).toEqual({ books: 0, highlights: 0, cards: 1, mature: 1, reviewedToday: 1 });
    expect(all.get('child')).toEqual({ books: 0, highlights: 0, cards: 1, mature: 1, reviewedToday: 1 });
  });

  it('rolls a three-level subtree up without double counting overlapping tags', async () => {
    await db.topics.bulkPut([topic('root', null), topic('mid', 'root'), topic('leaf', 'mid')]);
    const shared = book(['root', 'mid', 'leaf']);
    await db.books.bulkPut([shared, book(['leaf'])]);
    const sharedCard = card(['root', 'leaf'], { stability: 30 });
    const leafCard = card(['leaf'], { stability: 1 });
    await db.cards.bulkPut([sharedCard, leafCard]);

    const all = await topicProgressAll();
    expect(all.get('leaf')).toEqual({ books: 2, highlights: 0, cards: 2, mature: 1, reviewedToday: 0 });
    expect(all.get('mid')).toEqual({ books: 2, highlights: 0, cards: 2, mature: 1, reviewedToday: 0 });
    expect(all.get('root')).toEqual({ books: 2, highlights: 0, cards: 2, mature: 1, reviewedToday: 0 });
  });
});
