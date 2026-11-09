import Dexie, { type Table } from 'dexie';
import type {
  AudioCacheRecord,
  BookRecord,
  Bookmark,
  CardRecord,
  Highlight,
  LexiconEntry,
  ReviewLogRecord,
  Setting,
  Topic,
} from './types';

/**
 * The single local-first store. Schema changes: add a new `version(n).stores(...)`
 * block and a `.upgrade()` — never edit an existing version, users already have v1.
 */
export class PharmaReaderDB extends Dexie {
  books!: Table<BookRecord, string>;
  highlights!: Table<Highlight, string>;
  bookmarks!: Table<Bookmark, string>;
  cards!: Table<CardRecord, string>;
  reviewLogs!: Table<ReviewLogRecord, string>;
  topics!: Table<Topic, string>;
  lexicon!: Table<LexiconEntry, string>;
  audioCache!: Table<AudioCacheRecord, string>;
  settings!: Table<Setting, string>;

  constructor(name = 'PharmaReaderDB') {
    super(name);
    this.version(1).stores({
      books: 'id, title, addedAt, *topicIds',
      highlights: 'id, bookId, *topicIds, createdAt',
      bookmarks: 'id, bookId',
      cards: 'id, bookId, highlightId, *topicIds, createdAt',
      reviewLogs: 'id, cardId, reviewedAt',
      topics: 'id, parentId, order',
      lexicon: 'id, source',
      audioCache: 'key, createdAt',
      settings: 'key',
    });
  }
}

export const db = new PharmaReaderDB();

/** Ids are UUIDs so separate devices/backups can merge without collisions. */
export function newId(): string {
  return crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
