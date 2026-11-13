/**
 * The one question a PDF import asks: is this a textbook whose columns, tables
 * and boxes need the layout model, or a simple book that reads fine as text?
 *
 * `import.layout` stays the device-wide switch (Settings → PDF layout, and the
 * one Re-analyse uses); the answer here is for this import only, unless the
 * reader ticks "Don't ask again" — then it is stored under `IMPORT_LAYOUT_KEY`
 * and the sheet is skipped next time.
 */
import type { LayoutMode } from './pdf';

/** The stored answer to the import question; `ask` shows the sheet every time. */
export type ImportLayoutChoice = 'ask' | 'textbook' | 'simple';

/** Persisted answer to the import question. */
export const IMPORT_LAYOUT_KEY = 'import.layout.ask';

export const IMPORT_LAYOUT_OPTIONS: { value: ImportLayoutChoice; label: string }[] = [
  { value: 'ask', label: 'Ask every time' },
  { value: 'textbook', label: 'Textbook — use layout detection' },
  { value: 'simple', label: 'Simple book — skip detection' },
];

/**
 * Whether this browser can run the model at all. The weights live in Cache
 * Storage and nowhere else, exactly as `canStoreModel()` in the Settings panel
 * says, so a browser without it has no model to download or run.
 */
export function canRunLayoutModel(): boolean {
  return typeof caches !== 'undefined';
}

/** What an answer means for this import: a textbook wants the model, a simple book skips it. */
export function layoutForChoice(choice: 'textbook' | 'simple'): LayoutMode {
  return choice === 'textbook' ? 'auto' : 'heuristic';
}
