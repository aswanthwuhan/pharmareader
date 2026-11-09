import { createEmptyCard, fsrs, State, type Card as FsrsCard, type ReviewLog } from 'ts-fsrs';
import { db, newId } from '../core/db';
import { getSetting } from '../core/settings';
import type { Bookmark, BookRecord, CardRecord, Highlight, ReviewLogRecord } from '../core/types';
import type { ParsedDoc } from '../core/types';

/** ts-fsrs `Card` with its Dates as ISO strings, which is what IndexedDB stores. */
export type StoredFsrsCard = Omit<FsrsCard, 'due' | 'last_review'> & {
  due: string;
  last_review?: string;
};

export type StoredReviewLog = Omit<ReviewLog, 'due' | 'review'> & {
  due: string;
  review: string;
};

/** Card input: only front/back/kind are required. */
export type NewCard = Pick<CardRecord, 'front' | 'back' | 'kind'> &
  Partial<Pick<CardRecord, 'id' | 'bookId' | 'highlightId' | 'topicIds' | 'fsrs' | 'createdAt'>>;

export type NewHighlight = Omit<Highlight, 'id' | 'createdAt'> & Partial<Pick<Highlight, 'id' | 'createdAt'>>;

export type NewBookmark = Omit<Bookmark, 'id' | 'createdAt'> & Partial<Pick<Bookmark, 'id' | 'createdAt'>>;

const NEW_PER_DAY_KEY = 'study.newPerDay';
const DEFAULT_NEW_PER_DAY = 20;

function toIsoDate(value: unknown, fallback: Date): Date {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? fallback : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? fallback : d;
  }
  return fallback;
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Serialise a ts-fsrs card so IndexedDB/JSON round-trips keep the dates. */
export function toFsrs(card: FsrsCard): StoredFsrsCard {
  const { due, last_review, ...rest } = card;
  return {
    ...rest,
    due: due.toISOString(),
    ...(last_review ? { last_review: last_review.toISOString() } : {}),
  };
}

/** Read a stored card back, tolerating missing/partial fields from older exports. */
export function fromFsrs(value: unknown): FsrsCard {
  const v = (value ?? {}) as Partial<Record<keyof FsrsCard, unknown>>;
  const state = toNumber(v.state, State.New);
  const card: FsrsCard = {
    due: toIsoDate(v.due, new Date()),
    stability: toNumber(v.stability, 0),
    difficulty: toNumber(v.difficulty, 0),
    scheduled_days: toNumber(v.scheduled_days, 0),
    learning_steps: toNumber(v.learning_steps, 0),
    reps: toNumber(v.reps, 0),
    lapses: toNumber(v.lapses, 0),
    state: ([State.New, State.Learning, State.Review, State.Relearning] as readonly number[]).includes(state)
      ? (state as State)
      : State.New,
  };
  if (v.last_review !== undefined && v.last_review !== null) {
    card.last_review = toIsoDate(v.last_review, new Date(0));
  }
  return card;
}

export async function addHighlight(input: NewHighlight): Promise<Highlight> {
  const highlight: Highlight = {
    ...input,
    id: input.id ?? newId(),
    createdAt: input.createdAt ?? Date.now(),
  };
  await db.highlights.add(highlight);
  return highlight;
}

export async function updateHighlight(id: string, patch: Partial<Omit<Highlight, 'id'>>): Promise<void> {
  await db.highlights.update(id, patch);
}

/**
 * Remove a highlight. Cards made from it stay useful, so they are kept and
 * only unlinked — a dangling `highlightId` would break "jump to source".
 */
export async function deleteHighlight(id: string): Promise<void> {
  await db.transaction('rw', [db.highlights, db.cards], async () => {
    await db.highlights.delete(id);
    await db.cards.where('highlightId').equals(id).modify((card) => {
      delete card.highlightId;
    });
  });
}

export async function listHighlights(bookId: string): Promise<Highlight[]> {
  const rows = await db.highlights.where('bookId').equals(bookId).toArray();
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export async function addBookmark(input: NewBookmark): Promise<Bookmark> {
  const bookmark: Bookmark = {
    ...input,
    id: input.id ?? newId(),
    createdAt: input.createdAt ?? Date.now(),
  };
  await db.bookmarks.add(bookmark);
  return bookmark;
}

export async function deleteBookmark(id: string): Promise<void> {
  await db.bookmarks.delete(id);
}

export async function listBookmarks(bookId: string): Promise<Bookmark[]> {
  const rows = await db.bookmarks.where('bookId').equals(bookId).toArray();
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export async function createCard(input: NewCard): Promise<CardRecord> {
  const card: CardRecord = {
    ...input,
    id: input.id ?? newId(),
    topicIds: input.topicIds ?? [],
    fsrs: input.fsrs ?? toFsrs(createEmptyCard(new Date())),
    createdAt: input.createdAt ?? Date.now(),
  };
  await db.cards.add(card);
  return card;
}

export async function updateCard(id: string, patch: Partial<Omit<CardRecord, 'id'>>): Promise<void> {
  await db.cards.update(id, patch);
}

export async function deleteCard(id: string): Promise<void> {
  await db.transaction('rw', [db.cards, db.reviewLogs], async () => {
    await db.cards.delete(id);
    await db.reviewLogs.where('cardId').equals(id).delete();
  });
}

export async function listCards(): Promise<CardRecord[]> {
  const rows = await db.cards.toArray();
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

const WORD = /[A-Za-z][A-Za-z0-9'’-]*/g;

/**
 * Pick the token in `text` that a cloze is most useful on. Terms carry a digit
 * (CYP3A4, COX-2), or a capital (Aspirin); a plain long word (bioavailability)
 * is the fallback. Sentence-initial words like "The" are too short to win.
 */
function pickClozeToken(text: string): { start: number; end: number } | null {
  let best: { start: number; end: number; score: number; length: number } | null = null;
  for (const match of text.matchAll(WORD)) {
    const token = match[0];
    const score = /\d/.test(token) ? 3 : /^[A-Z]/.test(token) && token.length >= 4 ? 2 : token.length >= 6 ? 1 : 0;
    if (score === 0) continue;
    const start = match.index ?? 0;
    if (!best || score > best.score || (score === best.score && token.length > best.length)) {
      best = { start, end: start + token.length, score, length: token.length };
    }
  }
  if (best) return { start: best.start, end: best.end };

  // Nothing term-like: fall back to the longest word so the gap is meaningful.
  let longest: { start: number; end: number; length: number } | null = null;
  for (const match of text.matchAll(WORD)) {
    const start = match.index ?? 0;
    if (!longest || match[0].length > longest.length) {
      longest = { start, end: start + match[0].length, length: match[0].length };
    }
  }
  return longest ? { start: longest.start, end: longest.end } : null;
}

const EMPTY_PROMPT = 'Recall this highlight';

/**
 * Front text for a cloze card. A gap that swallows the whole highlight (a
 * one-word quote) or a highlight with no letters at all leaves nothing to cue
 * recall, so those fall back to a hint plus the answer's length.
 */
function clozeFront(text: string): string {
  const token = pickClozeToken(text);
  if (!token) {
    const chars = text.replace(/\s+/g, '').length;
    return chars > 0 ? `[...] (${chars} characters)` : '[...]';
  }
  const before = text.slice(0, token.start);
  const after = text.slice(token.end);
  if (!/[A-Za-z0-9]/.test(before) && !/[A-Za-z0-9]/.test(after)) {
    const word = text.slice(token.start, token.end);
    return `${word.slice(0, 1)}[...] (${word.length} characters)`;
  }
  return `${before}[...]${after}`;
}

/** Build a card from a highlight. Pure: hand the result to `createCard` to save. */
export function cardFromHighlight(h: Highlight, kind: 'qa' | 'cloze'): CardRecord {
  const text = h.text.trim();
  let front: string;
  if (kind === 'cloze') {
    front = clozeFront(text);
  } else {
    const words = text.split(/\s+/).filter(Boolean);
    front = words.length
      ? `Explain: ${words.slice(0, 12).join(' ')}${words.length > 12 ? '…' : ''}`
      : EMPTY_PROMPT;
  }
  const note = h.note?.trim();
  return {
    id: newId(),
    bookId: h.bookId,
    highlightId: h.id,
    kind,
    front,
    back: [text, note].filter(Boolean).join('\n\n'),
    topicIds: [...h.topicIds],
    fsrs: toFsrs(createEmptyCard(new Date())),
    createdAt: Date.now(),
  };
}

function startOfToday(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** New cards already introduced today, so the daily allowance can be enforced. */
async function newCardsReviewedToday(now: number): Promise<number> {
  const logs = await db.reviewLogs.where('reviewedAt').aboveOrEqual(startOfToday(now)).toArray();
  return logs.filter((log) => (log.log as { state?: unknown } | null)?.state === State.New).length;
}

/** `study.newPerDay` as a usable allowance; absent or nonsense values use the default. */
function perDayAllowance(value: unknown): number {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_NEW_PER_DAY;
}

/**
 * Cards ready now, earliest due first. New cards are capped per day
 * (`study.newPerDay`, default 20) because introducing more never sticks.
 */
export async function dueCards(limit: number, topicIds?: string[]): Promise<CardRecord[]> {
  const now = Date.now();
  const cards = await db.cards.toArray();
  const filtered = topicIds?.length
    ? cards.filter((c) => c.topicIds.some((id) => topicIds.includes(id)))
    : cards;

  const due = filtered
    .map((record) => ({ record, fsrsCard: fromFsrs(record.fsrs) }))
    .filter(({ fsrsCard }) => fsrsCard.due.getTime() <= now);

  const perDay = perDayAllowance(await getSetting<unknown>(NEW_PER_DAY_KEY, DEFAULT_NEW_PER_DAY));
  const allowance = Math.max(0, perDay - (await newCardsReviewedToday(now)));

  const fresh = due
    .filter(({ fsrsCard }) => fsrsCard.state === State.New)
    .sort((a, b) => a.record.createdAt - b.record.createdAt)
    .slice(0, allowance);
  const learning = due.filter(({ fsrsCard }) => fsrsCard.state !== State.New);

  return [...fresh, ...learning]
    .sort((a, b) => a.fsrsCard.due.getTime() - b.fsrsCard.due.getTime())
    .slice(0, limit)
    .map(({ record }) => record);
}

export interface ReviewResult {
  card: CardRecord;
  log: ReviewLogRecord;
}

/** Apply one FSRS rating and persist both the updated card and the review log. */
export async function reviewCard(cardId: string, rating: 1 | 2 | 3 | 4): Promise<ReviewResult> {
  // Rating.Manual (0) and out-of-range grades corrupt the scheduling state.
  if (!Number.isInteger(rating) || rating < 1 || rating > 4) {
    throw new Error(`Invalid rating: ${String(rating)}`);
  }
  const record = await db.cards.get(cardId);
  if (!record) throw new Error(`Card ${cardId} not found`);

  const now = new Date();
  const { card: nextCard, log } = fsrs().next(fromFsrs(record.fsrs), now, rating);

  const updated: CardRecord = { ...record, fsrs: toFsrs(nextCard) };
  const reviewLog: ReviewLogRecord = {
    id: newId(),
    cardId,
    rating,
    reviewedAt: now.getTime(),
    log: { ...log, due: log.due.toISOString(), review: log.review.toISOString() } satisfies StoredReviewLog,
  };

  await db.transaction('rw', [db.cards, db.reviewLogs], async () => {
    await db.cards.put(updated);
    await db.reviewLogs.add(reviewLog);
  });
  return { card: updated, log: reviewLog };
}

function findChapterTitle(parsed: ParsedDoc | undefined, sentenceIds: string[]): string | undefined {
  if (!parsed) return undefined;
  for (const chapter of parsed.chapters) {
    for (const block of chapter.blocks) {
      if (block.sentences.some((s) => sentenceIds.includes(s.id))) return chapter.title;
    }
  }
  return undefined;
}

function markdownDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

/** Notes as Markdown, grouped by book then chapter, with the highlight's note. */
export async function exportNotesMarkdown(bookId?: string): Promise<string> {
  // Reading one book's record is enough for a per-book export; loading every
  // record would pull every stored file blob into memory for nothing.
  const [books, highlights] = await Promise.all([
    bookId ? db.books.where('id').equals(bookId).toArray() : db.books.toArray(),
    bookId ? db.highlights.where('bookId').equals(bookId).toArray() : db.highlights.toArray(),
  ]);

  const bookById = new Map<string, BookRecord>(books.map((b) => [b.id, b]));
  const grouped = new Map<string, Map<string, Highlight[]>>();
  for (const highlight of highlights) {
    const book = bookById.get(highlight.bookId);
    const chapter = findChapterTitle(book?.parsed, highlight.sentenceIds) ?? 'Unlinked';
    const byChapter = grouped.get(highlight.bookId) ?? new Map<string, Highlight[]>();
    const list = byChapter.get(chapter) ?? [];
    list.push(highlight);
    byChapter.set(chapter, list);
    grouped.set(highlight.bookId, byChapter);
  }

  const lines = ['# PharmaReader notes', '', `_Exported ${markdownDate(Date.now())}_`, ''];
  if (grouped.size === 0) {
    lines.push('_No highlights yet._', '');
  }

  const orderedBooks = [...grouped.keys()].sort((a, b) => {
    const titleA = bookById.get(a)?.title ?? a;
    const titleB = bookById.get(b)?.title ?? b;
    return titleA.localeCompare(titleB);
  });

  for (const id of orderedBooks) {
    const book = bookById.get(id);
    const byChapter = grouped.get(id);
    if (!byChapter) continue;
    lines.push(`## ${book?.title ?? id}${book?.author ? ` — ${book.author}` : ''}`, '');

    const chapterOrder = book?.parsed.chapters.map((c) => c.title) ?? [];
    const chapterNames = [...byChapter.keys()].sort((a, b) => {
      const ai = chapterOrder.indexOf(a);
      const bi = chapterOrder.indexOf(b);
      return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi) || a.localeCompare(b);
    });

    for (const chapter of chapterNames) {
      lines.push(`### ${chapter}`, '');
      const list = [...(byChapter.get(chapter) ?? [])].sort((a, b) => a.createdAt - b.createdAt);
      for (const highlight of list) {
        lines.push(`- ${oneLine(highlight.text)}`);
        if (highlight.note?.trim()) lines.push(`  - **Note:** ${oneLine(highlight.note)}`);
      }
      lines.push('');
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function csvCell(value: string): string {
  return /[";,\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Anki splits tags on whitespace, so a title like "Drug metabolism" needs an underscore. */
function ankiTag(value: string): string {
  return value.trim().replace(/\s+/g, '_');
}

/**
 * Anki text import (`front;back;tags`). Topic ids become titles when the
 * syllabus knows them, otherwise the raw id keeps the tag traceable.
 */
export async function exportCardsCsv(): Promise<string> {
  const [cards, topics] = await Promise.all([db.cards.toArray(), db.topics.toArray()]);
  const titleById = new Map(topics.map((t) => [t.id, t.title]));
  const rows = cards
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((card) => {
      const tags = card.topicIds
        .map((id) => ankiTag(titleById.get(id) ?? id))
        .filter(Boolean)
        .join(' ');
      return [card.front, card.back, tags].map(csvCell).join(';');
    });
  // Anki reads these comments to pick the field separator and the tags column;
  // without the tags column the third field would be imported as a note field.
  return ['#separator:Semicolon', '#tags column:3', ...rows].join('\n');
}
