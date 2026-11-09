import { afterEach, describe, expect, it } from 'vitest';
import { db, newId } from '../core/db';
import { setSetting } from '../core/settings';
import type { BookRecord, Bookmark, CardRecord, Highlight, Topic } from '../core/types';
import {
  addBookmark,
  addHighlight,
  cardFromHighlight,
  createCard,
  deleteBookmark,
  deleteHighlight,
  dueCards,
  exportCardsCsv,
  exportNotesMarkdown,
  fromFsrs,
  listBookmarks,
  listHighlights,
  reviewCard,
  toFsrs,
  updateHighlight,
} from './api';
import { createEmptyCard } from 'ts-fsrs';

const book = (title = 'Basic & Clinical Pharmacology'): BookRecord => ({
  id: newId(),
  title,
  author: 'Katzung',
  format: 'pdf',
  addedAt: Date.now(),
  fileBlob: new Blob(['%PDF-1.4 test']),
  parsed: {
    title,
    format: 'pdf',
    chapters: [
      {
        id: 'ch1',
        title: 'Pharmacokinetics',
        blocks: [{ id: 'b1', kind: 'p', sentences: [{ id: 's1', text: 'Bioavailability is the fraction of the dose reaching circulation.' }] }],
      },
    ],
  },
  topicIds: ['pharmacokinetics'],
});

const highlight = (bookId: string, text: string, note?: string): Highlight => ({
  id: newId(),
  bookId,
  sentenceIds: ['s1'],
  text,
  color: 'yellow',
  note,
  topicIds: ['pharmacokinetics'],
  createdAt: Date.now(),
});

afterEach(async () => {
  await db.delete();
  await db.open();
});

describe('highlights and bookmarks', () => {
  it('creates, lists newest-first, updates and deletes highlights', async () => {
    const b = book();
    await db.books.add(b);

    const first = await addHighlight({ ...highlight(b.id, 'First highlight'), createdAt: 1 });
    const second = await addHighlight(highlight(b.id, 'Second highlight'));

    expect(await listHighlights(b.id)).toMatchObject([second, first].map((h) => ({ id: h.id, text: h.text })));
    // Only this book's highlights come back.
    expect(await listHighlights('other-book')).toEqual([]);

    await updateHighlight(first.id, { note: 'remember this', color: 'green' });
    expect(await db.highlights.get(first.id)).toMatchObject({ note: 'remember this', color: 'green' });

    await deleteHighlight(second.id);
    expect(await db.highlights.get(second.id)).toBeUndefined();
  });

  it('creates, lists and deletes bookmarks', async () => {
    const b = book();
    await db.books.add(b);
    const bookmark: Bookmark = { id: newId(), bookId: b.id, chapterId: 'ch1', sentenceId: 's1', label: 'Start here', createdAt: 5 };
    await addBookmark(bookmark);

    expect(await listBookmarks(b.id)).toMatchObject([{ id: bookmark.id, label: 'Start here', sentenceId: 's1' }]);

    await deleteBookmark(bookmark.id);
    expect(await db.bookmarks.get(bookmark.id)).toBeUndefined();
  });
});

describe('fsrs serialisation', () => {
  it('round-trips dates through ISO strings', () => {
    const card = createEmptyCard(new Date('2026-01-02T03:04:05.000Z'));
    const stored = toFsrs(card);
    expect(stored.due).toBe('2026-01-02T03:04:05.000Z');
    expect(toFsrs(fromFsrs(stored)).due).toBe(stored.due);
  });

  it('falls back to a fresh card for missing or corrupt values', () => {
    const card = fromFsrs(undefined);
    expect(card.state).toBe(0);
    expect(card.due).toBeInstanceOf(Date);
    expect(fromFsrs({ state: 99 }).state).toBe(0);
  });
});

describe('cardFromHighlight', () => {
  const b = book();

  it('blanks a term for a cloze card', () => {
    const h = highlight(b.id, 'Warfarin is metabolised by CYP2C9 and has a narrow therapeutic index.');
    const card = cardFromHighlight(h, 'cloze');

    expect(card.kind).toBe('cloze');
    expect(card.front).toContain('[...]');
    expect(card.front).not.toContain('CYP2C9');
    expect(card.front).toContain('Warfarin');
    expect(card.back).toBe(h.text);
    expect(card.topicIds).toEqual(['pharmacokinetics']);
    expect(card.highlightId).toBe(h.id);
    expect(card.bookId).toBe(b.id);
  });

  it('prefers a capitalised term when there are no digits', () => {
    const card = cardFromHighlight(highlight(b.id, 'Bioavailability describes the fraction of an administered dose.'), 'cloze');
    expect(card.front).not.toContain('Bioavailability');
    expect(card.front).toContain('[...] describes');
  });

  it('builds an "Explain" prompt and keeps the note on the back for Q&A', () => {
    const longText = 'Aspirin irreversibly acetylates platelet cyclooxygenase one which blocks thromboxane synthesis for the lifespan of the platelet in circulation.';
    const h = highlight(b.id, longText, 'Low dose is antiplatelet.');
    const card = cardFromHighlight(h, 'qa');

    expect(card.kind).toBe('qa');
    expect(card.front.startsWith('Explain: ')).toBe(true);
    expect(card.front.endsWith('…')).toBe(true);
    expect(card.front.split(/\s+/)).toHaveLength(13); // "Explain:" + 12 words
    expect(card.back).toBe(`${longText}\n\nLow dose is antiplatelet.`);
  });

  it('does not add an ellipsis when the text is short', () => {
    const card = cardFromHighlight(highlight(b.id, 'Aspirin is an NSAID.'), 'qa');
    expect(card.front).toBe('Explain: Aspirin is an NSAID.');
  });
});

describe('reviewCard', () => {
  it('schedules a new card into the future after a Good rating', async () => {
    const card = await createCard({ front: 'Q', back: 'A', kind: 'qa' });
    const before = Date.now();

    const result = await reviewCard(card.id, 3);
    const due = new Date((result.card.fsrs as { due: string }).due).getTime();

    expect(due).toBeGreaterThan(before);
    expect((result.card.fsrs as { reps: number }).reps).toBe(1);
    expect(result.log.rating).toBe(3);
    expect(result.log.reviewedAt).toBeGreaterThanOrEqual(before);
    expect(await db.reviewLogs.where('cardId').equals(card.id).count()).toBe(1);
  });

  it('throws for an unknown card id', async () => {
    await expect(reviewCard('nope', 3)).rejects.toThrow(/not found/);
  });
});

describe('dueCards', () => {
  const many = async (count: number, topicIds: string[] = []): Promise<CardRecord[]> => {
    const cards: CardRecord[] = [];
    for (let i = 0; i < count; i += 1) {
      cards.push(await createCard({ front: `Q${i}`, back: `A${i}`, kind: 'qa', topicIds }));
    }
    return cards;
  };

  it('caps new cards at 20 per day by default', async () => {
    await many(25);
    expect(await dueCards(100)).toHaveLength(20);
  });

  it('honours the study.newPerDay setting', async () => {
    await many(25);
    await setSetting('study.newPerDay', 5);
    expect(await dueCards(100)).toHaveLength(5);
  });

  it('counts new cards already reviewed today against the cap', async () => {
    const cards = await many(25);
    await reviewCard(cards[0]!.id, 3);
    expect(await dueCards(100)).toHaveLength(19);
  });

  it('filters by topic and sorts by due date', async () => {
    const topicA = await many(2, ['topic-a']);
    await many(2, ['topic-b']);
    const due = await dueCards(100, ['topic-a']);
    expect(due.map((c) => c.id).sort()).toEqual(topicA.map((c) => c.id).sort());

    const all = await dueCards(2);
    expect(all).toHaveLength(2);
  });
});

describe('exports', () => {
  it('groups notes by book and chapter with notes', async () => {
    const b = book();
    await db.books.add(b);
    await db.highlights.add(highlight(b.id, 'Bioavailability is the fraction reaching circulation.', 'exam favourite'));

    const md = await exportNotesMarkdown();
    expect(md).toContain(`## ${b.title} — Katzung`);
    expect(md).toContain('### Pharmacokinetics');
    expect(md).toContain('- Bioavailability is the fraction reaching circulation.');
    expect(md).toContain('  - **Note:** exam favourite');
  });

  it('writes Anki-style CSV with quotes and topic titles', async () => {
    const topic: Topic = { id: 't1', parentId: null, title: 'Pharmacokinetics', level: 'basic', order: 1 };
    await db.topics.add(topic);
    await createCard({
      front: 'What does "t½" mean; really?',
      back: 'Half-life\nin hours',
      kind: 'qa',
      topicIds: ['t1'],
    });
    await createCard({ front: 'Question', back: 'Answer', kind: 'qa', topicIds: ['unknown-topic'] });

    const csv = await exportCardsCsv();
    expect(csv.split('\n')[0]).toBe('#separator:Semicolon');
    expect(csv).toContain('"What does ""t½"" mean; really?";"Half-life\nin hours";Pharmacokinetics');
    expect(csv).toContain('Question;Answer;unknown-topic');
  });
});
