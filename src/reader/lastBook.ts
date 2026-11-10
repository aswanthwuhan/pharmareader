/**
 * The book the reader was last in, for the library's "Continue listening"
 * button. It is a setting, not a column on the book: opening a book must not
 * rewrite that record (it carries the parsed document), and the value is only
 * a hint — when the book is gone, the button simply does not appear.
 */
export const LAST_BOOK_KEY = 'reader.lastBook';

export interface LastBook {
  bookId: string;
  /** Epoch ms, so the library can show the most recent book first. */
  at: number;
}
