import { afterEach, describe, expect, it, vi } from 'vitest';
import { db, newId } from '../core/db';
import { setSetting } from '../core/settings';
import type { BookRecord, Bookmark, CardRecord, Highlight, Topic } from '../core/types';
import {
  addBookmark,
  addHighlight,
  cardFromHighlight,
  createCard,
  deleteBookmark,
  deleteCard,
  deleteHighlight,
  dueCards,
  exportCardsCsv,
  exportNotesMarkdown,
  findRangeHighlight,
  fromFsrs,
  listBookmarks,
  listHighlights,
  rangeHighlightPatch,
  reviewCard,
  reviewNow,
  toFsrs,
  undoReview,
  updateCard,
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

  it('keeps cards made from a deleted highlight and only unlinks them', async () => {
    const b = book();
    const source = await addHighlight(highlight(b.id, 'Warfarin is metabolised by CYP2C9.'));
    const card = await createCard(cardFromHighlight(source, 'cloze'));

    await deleteHighlight(source.id);

    const kept = await db.cards.get(card.id);
    expect(kept).toBeDefined();
    expect(kept?.front).toBe(card.front);
    // The link is removed rather than left dangling.
    expect(kept && 'highlightId' in kept).toBe(false);
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

  it('keeps last_review and learning_steps through storage', async () => {
    const card = await createCard({ front: 'Q', back: 'A', kind: 'qa' });
    const { card: reviewed } = await reviewCard(card.id, 3);

    const stored = reviewed.fsrs as { due: string; last_review?: string; learning_steps: number };
    expect(typeof stored.last_review).toBe('string');
    expect(stored.learning_steps).toBe(1);

    // What IndexedDB hands back must still schedule the same way.
    const reread = fromFsrs((await db.cards.get(card.id))?.fsrs);
    expect(reread.last_review).toBeInstanceOf(Date);
    expect(reread.learning_steps).toBe(1);
    expect(reread.due.getTime()).toBe(new Date(stored.due).getTime());
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

  it('never blanks the whole highlight for a one-word cloze', () => {
    const card = cardFromHighlight(highlight(b.id, 'Aspirin'), 'cloze');
    expect(card.front).not.toBe('[...]');
    // The first letter plus the length still gives the learner a foothold.
    expect(card.front).toBe('A[...] (7 characters)');
  });

  it('falls back to a length hint when the highlight has no word at all', () => {
    const card = cardFromHighlight(highlight(b.id, '1 2 3'), 'cloze');
    expect(card.front).toBe('[...] (3 characters)');
  });

  it('never produces an empty Q&A prompt', () => {
    const card = cardFromHighlight(highlight(b.id, '   '), 'qa');
    expect(card.front).toBe('Recall this highlight');
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

  it('rejects ratings outside 1-4 before touching the card', async () => {
    const card = await createCard({ front: 'Q', back: 'A', kind: 'qa' });
    // Rating.Manual (0) and 5 are not grades FSRS can schedule from.
    await expect(reviewCard(card.id, 0 as unknown as 1)).rejects.toThrow(/Invalid rating/);
    await expect(reviewCard(card.id, 5 as unknown as 1)).rejects.toThrow(/Invalid rating/);
    expect(await db.reviewLogs.count()).toBe(0);
    expect((await db.cards.get(card.id))?.fsrs).toMatchObject({ reps: 0 });
  });

  it('clamps a review dated before the card’s own last_review', async () => {
    const card = await createCard({ front: 'Q', back: 'A', kind: 'qa' });
    const first = await reviewCard(card.id, 3);
    const lastReview = new Date((first.card.fsrs as { last_review: string }).last_review).getTime();

    // A clock moved backwards would otherwise hand ts-fsrs a negative delta_t,
    // which it rejects outright.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(lastReview - 24 * 60 * 60 * 1000);
      const second = await reviewCard(card.id, 3);
      const fsrs = second.card.fsrs as { due: string; last_review: string; reps: number };

      expect(fsrs.reps).toBe(2);
      // The new review is dated at, not before, the last one.
      expect(new Date(fsrs.last_review).getTime()).toBe(lastReview);
      expect(second.log.reviewedAt).toBe(lastReview);
      expect(Number.isNaN(new Date(fsrs.due).getTime())).toBe(false);
      expect(await db.reviewLogs.where('cardId').equals(card.id).count()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reviewNow', () => {
  const lastReview = new Date('2026-01-10T09:00:00Z');

  it('holds a clock that went backwards at the card’s last review', () => {
    const behind = new Date('2026-01-09T21:00:00Z');
    expect(reviewNow(lastReview, behind).getTime()).toBe(lastReview.getTime());
  });

  it('leaves a clock at or ahead of the last review alone', () => {
    const ahead = new Date('2026-01-11T09:00:00Z');
    expect(reviewNow(lastReview, ahead).getTime()).toBe(ahead.getTime());
    expect(reviewNow(lastReview, new Date(lastReview)).getTime()).toBe(lastReview.getTime());
    // A card that has never been reviewed has nothing to be held at.
    expect(reviewNow(undefined, ahead).getTime()).toBe(ahead.getTime());
  });
});

describe('undoReview', () => {
  it('restores the card row and deletes exactly the log the rating wrote', async () => {
    const card = await createCard({ front: 'Q', back: 'A', kind: 'qa' });
    const otherCard = await createCard({ front: 'Q2', back: 'A2', kind: 'qa' });
    const otherReview = await reviewCard(otherCard.id, 3);
    const before = await db.cards.get(card.id);

    const result = await reviewCard(card.id, 4);
    expect((await db.cards.get(card.id))?.fsrs).not.toEqual(before?.fsrs);

    await undoReview(result, before!);

    // Byte-for-byte the pre-rating row, and the card is due again.
    expect(await db.cards.get(card.id)).toEqual(before);
    expect(await db.reviewLogs.get(result.log.id)).toBeUndefined();
    expect(await db.reviewLogs.where('cardId').equals(card.id).count()).toBe(0);
    // The other card's history is not collateral damage.
    expect(await db.reviewLogs.get(otherReview.log.id)).toEqual(otherReview.log);
    expect(await db.reviewLogs.count()).toBe(1);
  });

  it('refuses a previous card that is not the card the rating touched', async () => {
    const card = await createCard({ front: 'Q', back: 'A', kind: 'qa' });
    const otherCard = await createCard({ front: 'Q2', back: 'A2', kind: 'qa' });
    const result = await reviewCard(card.id, 3);
    const otherBefore = await db.cards.get(otherCard.id);

    // Restoring another card's row here would overwrite that card.
    await expect(undoReview(result, otherBefore!)).rejects.toThrow(/does not match/);
    expect((await db.cards.get(card.id))?.fsrs).toEqual(result.card.fsrs);
    expect(await db.cards.get(otherCard.id)).toEqual(otherBefore);
    expect(await db.reviewLogs.get(result.log.id)).toBeDefined();
  });

  it('refuses to undo a card that was deleted since, and does not resurrect it', async () => {
    const card = await createCard({ front: 'Q', back: 'A', kind: 'qa' });
    const before = await db.cards.get(card.id);
    const result = await reviewCard(card.id, 3);
    // Deleted from the Cards tab or another window while the session was open.
    await deleteCard(card.id);

    // Putting the whole old row back would bring a deleted card back to life.
    await expect(undoReview(result, before!)).rejects.toThrow(/deleted/);
    expect(await db.cards.get(card.id)).toBeUndefined();
    expect(await db.reviewLogs.count()).toBe(0);
  });

  it('refuses to undo once the card has been rated again, keeping the newer rating', async () => {
    const card = await createCard({ front: 'Q', back: 'A', kind: 'qa' });
    const before = await db.cards.get(card.id);
    const first = await reviewCard(card.id, 1);
    const second = await reviewCard(card.id, 4);

    await expect(undoReview(first, before!)).rejects.toThrow(/changed/);
    expect((await db.cards.get(card.id))?.fsrs).toEqual(second.card.fsrs);
    expect(await db.reviewLogs.where('cardId').equals(card.id).count()).toBe(2);
    expect(await db.reviewLogs.get(first.log.id)).toEqual(first.log);
  });

  it('cannot be applied twice to the same rating', async () => {
    const card = await createCard({ front: 'Q', back: 'A', kind: 'qa' });
    const before = await db.cards.get(card.id);
    const result = await reviewCard(card.id, 2);

    await undoReview(result, before!);
    // A second undo would put the same schedule back and delete a log that is gone.
    await expect(undoReview(result, before!)).rejects.toThrow(/changed/);
    expect((await db.cards.get(card.id))?.fsrs).toEqual(before!.fsrs);
    expect(await db.reviewLogs.count()).toBe(0);
  });

  it('restores only the schedule, so an edit made after the rating survives', async () => {
    const card = await createCard({ front: 'Q', back: 'A', kind: 'qa' });
    const before = await db.cards.get(card.id);
    const result = await reviewCard(card.id, 3);
    await updateCard(card.id, { front: 'Q edited' });

    await undoReview(result, before!);

    const restored = await db.cards.get(card.id);
    expect(restored?.fsrs).toEqual(before!.fsrs);
    expect(restored?.front).toBe('Q edited');
  });

  it('gives a new card back to the daily allowance', async () => {
    for (let i = 0; i < 3; i += 1) await createCard({ front: `Q${i}`, back: `A${i}`, kind: 'qa' });
    await setSetting('study.newPerDay', 2);
    expect(await dueCards(100)).toHaveLength(2);

    const [firstDue] = await dueCards(100);
    const before = await db.cards.get(firstDue!.id);
    const result = await reviewCard(firstDue!.id, 3);
    expect(await dueCards(100)).toHaveLength(1);

    await undoReview(result, before!);
    // The log that counted against today's allowance went with it.
    expect(await db.reviewLogs.count()).toBe(0);
    expect(await dueCards(100)).toHaveLength(2);
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

  it('accepts a numeric string and falls back to the default for nonsense', async () => {
    await many(25);
    await setSetting('study.newPerDay', '7');
    expect(await dueCards(100)).toHaveLength(7);

    // A corrupt row must not silently stop every new card.
    await setSetting('study.newPerDay', 'lots');
    expect(await dueCards(100)).toHaveLength(20);
  });

  it('allows zero new cards per day when that is the setting', async () => {
    await many(3);
    await setSetting('study.newPerDay', 0);
    expect(await dueCards(100)).toEqual([]);
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

  it('reads only the requested book record when exporting one book', async () => {
    const wanted = book('Wanted');
    const other = book('Other');
    await db.books.add(wanted);
    await db.books.add(other);
    await db.highlights.add(highlight(wanted.id, 'Keep this one.'));
    await db.highlights.add(highlight(other.id, 'Leave this one out.'));

    const everyBook = vi.spyOn(db.books, 'toArray');
    try {
      const md = await exportNotesMarkdown(wanted.id);
      // Book records carry the whole file blob, so loading them all is a memory spike.
      expect(everyBook).not.toHaveBeenCalled();
      expect(md).toContain('Keep this one.');
      expect(md).not.toContain('Leave this one out.');
    } finally {
      everyBook.mockRestore();
    }
  });

  it('declares the tags column and sanitises tags for Anki', async () => {
    const topic: Topic = { id: 't2', parentId: null, title: 'Drug metabolism', level: 'basic', order: 2 };
    await db.topics.add(topic);
    await createCard({ front: 'Q', back: 'A', kind: 'qa', topicIds: ['t2'] });

    const csv = await exportCardsCsv();
    // Without the header Anki imports the tags as a third field of the note.
    expect(csv.split('\n')[1]).toBe('#tags column:3');
    // Anki splits tags on whitespace, so a spaced title has to become one tag.
    expect(csv).toContain('Q;A;Drug_metabolism');
  });
});

describe('range highlights', () => {
  it('finds only the highlight covering exactly the same sentences', () => {
    const single = highlight('book', 'one sentence');
    const pair = { ...highlight('book', 'two sentences'), sentenceIds: ['s1', 's2'] };

    expect(findRangeHighlight([single, pair], ['s1'])?.id).toBe(single.id);
    expect(findRangeHighlight([single, pair], ['s2'])).toBeUndefined();
    expect(findRangeHighlight([single, pair], ['s1', 's2'])?.id).toBe(pair.id);
    expect(findRangeHighlight([single, pair], ['s2', 's1'])).toBeUndefined();
  });

  it('recolours on a colour tap and keeps the colour when a note is added', () => {
    const existing = { ...highlight('book', 'text'), color: 'green' as const };

    // A swatch tap always means "this colour now".
    expect(rangeHighlightPatch(existing, 'blue')).toEqual({ color: 'blue' });
    // The note action has no colour of its own: adding a note must not recolour.
    expect(rangeHighlightPatch(existing, 'yellow', 'remember this')).toEqual({ note: 'remember this' });
    expect(rangeHighlightPatch(existing, 'green')).toEqual({});
  });
});
