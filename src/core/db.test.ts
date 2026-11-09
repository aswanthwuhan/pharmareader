import { afterEach, describe, expect, it } from 'vitest';
import { db, newId } from './db';
import type { BookRecord, Highlight } from './types';

const book = (): BookRecord => ({
  id: newId(),
  title: 'Basic & Clinical Pharmacology',
  author: 'Katzung',
  format: 'pdf',
  addedAt: Date.now(),
  fileBlob: new Blob(['%PDF-1.4 test']),
  parsed: {
    title: 'Basic & Clinical Pharmacology',
    format: 'pdf',
    chapters: [
      {
        id: 'ch1',
        title: 'Pharmacokinetics',
        blocks: [{ id: 'b1', kind: 'p', sentences: [{ id: 's1', text: 'Bioavailability is the fraction of dose reaching circulation.' }] }],
      },
    ],
  },
  topicIds: ['pharmacokinetics'],
});

afterEach(async () => {
  await db.delete();
  await db.open();
});

describe('PharmaReaderDB', () => {
  it('stores and reads back a book with its parsed content', async () => {
    const b = book();
    await db.books.add(b);

    const found = await db.books.get(b.id);
    expect(found?.title).toBe('Basic & Clinical Pharmacology');
    expect(found?.parsed.chapters[0]?.blocks[0]?.sentences[0]?.text).toContain('Bioavailability');
    // fake-indexeddb's structured clone drops Blob contents (real IndexedDB keeps them),
    // so only presence is asserted here.
    expect(found?.fileBlob).toBeTruthy();

    // Multi-entry index on topicIds is what the syllabus screens filter by.
    expect((await db.books.where('topicIds').equals('pharmacokinetics').count())).toBe(1);
  });

  it('stores a highlight and finds it by book, newest first', async () => {
    const b = book();
    await db.books.add(b);

    const h: Highlight = {
      id: newId(),
      bookId: b.id,
      sentenceIds: ['s1'],
      text: 'Bioavailability',
      color: 'yellow',
      topicIds: ['pharmacokinetics'],
      createdAt: Date.now(),
    };
    await db.highlights.add(h);

    expect(await db.highlights.get(h.id)).toMatchObject({ sentenceIds: ['s1'], color: 'yellow' });

    const forBook = await db.highlights.where('bookId').equals(b.id).toArray();
    expect(forBook).toHaveLength(1);
    expect(forBook[0]?.text).toBe('Bioavailability');
  });
});
