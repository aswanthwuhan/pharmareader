/**
 * Text normalisation for TTS: turn pharmacology notation into words the speech
 * engines get right ("t½" → "half-life", "CYP3A4" → "C Y P three eigh four").
 *
 * Built-in entries live in `pharma-lexicon.json` and are seeded into
 * `db.lexicon` on first use. Every row carries a stable id: `b-<n>` for the core
 * rules and `rx-<n>` for the drug-name respellings, so a re-seed can update the
 * rows in place while keeping the user's on/off choices. Rules are applied in
 * *file* order (not id order) — the JSON is ordered from the most specific
 * pattern to the generic glyph rules at the end. User entries always run first,
 * in creation order, then the built-ins.
 *
 * Convention for letter names: espeak-ng reads a bare capital "A" as the
 * article ("uh"), so letter sequences are written with dots between the
 * capitals ("A.C.E", "A.N.S", "A.T.P-ace") and a lone A as "eigh", which is the
 * only spelling espeak turns into /eɪ/. See `drug-respellings.md`.
 */
import rawLexicon from './pharma-lexicon.json?raw';
import { db } from '../../core/db';
import type { LexiconEntry } from '../../core/types';
import { sha256Hex } from '../cache';

interface RawEntry {
  id: string;
  pattern: string;
  replacement: string;
  isRegex: boolean;
}

export const BUILTIN_LEXICON: readonly RawEntry[] = JSON.parse(rawLexicon) as RawEntry[];

/** Where each built-in applies in the pipeline: the order it has in the file. */
const BUILTIN_ORDER: ReadonlyMap<string, number> = new Map(BUILTIN_LEXICON.map((e, i) => [e.id, i]));

/** The seeded rows, in file order, before any user toggle is applied. */
function builtinRecords(): LexiconEntry[] {
  return BUILTIN_LEXICON.map((e) => ({
    id: e.id,
    pattern: e.pattern,
    replacement: e.replacement,
    isRegex: e.isRegex,
    source: 'builtin',
    enabled: true,
  }));
}

/** Position in the pipeline; unknown ids sort last so a stale row cannot jump ahead. */
function builtinOrder(id: string): number {
  return BUILTIN_ORDER.get(id) ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Which toggleable group an entry belongs to. Drug respellings can be switched
 * off as one group without touching the notation rules.
 */
export function entryGroup(id: string): 'core' | 'drug' {
  return id.startsWith('rx-') ? 'drug' : 'core';
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

let seeding: Promise<void> | null = null;

/** Create/refresh the built-in rows. Safe to call on every app start. */
export async function seedLexicon(): Promise<void> {
  if (!seeding) {
    seeding = seed().finally(() => {
      seeding = null;
    });
  }
  await seeding;
}

async function seed(): Promise<void> {
  const existing = await db.lexicon.where('source').equals('builtin').toArray();
  const byId = new Map(existing.map((e) => [e.id, e]));
  const wanted = builtinRecords();
  const wantedIds = new Set(wanted.map((e) => e.id));

  const changed: LexiconEntry[] = [];
  for (const next of wanted) {
    const prev = byId.get(next.id);
    const same =
      prev !== undefined &&
      prev.pattern === next.pattern &&
      prev.replacement === next.replacement &&
      prev.isRegex === next.isRegex;
    // Keep a toggle the user already made on this row.
    if (!same) changed.push({ ...next, enabled: prev ? prev.enabled : true });
  }
  const stale = existing.filter((e) => !wantedIds.has(e.id)).map((e) => e.id);

  if (changed.length > 0 || stale.length > 0) {
    await db.transaction('rw', db.lexicon, async () => {
      if (changed.length > 0) await db.lexicon.bulkPut(changed);
      if (stale.length > 0) await db.lexicon.bulkDelete(stale);
    });
    invalidate();
  }
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

export function invalidate(): void {
  enabledCache = null;
  versionCache = null;
}

let enabledCache: LexiconEntry[] | null = null;
let versionCache: string | null = null;

// A half-typed regex in the editor must never break playback.
const regexCache = new Map<string, RegExp | null>();

function regexFor(pattern: string): RegExp | null {
  let re = regexCache.get(pattern);
  if (re === undefined) {
    try {
      re = new RegExp(pattern, 'g');
    } catch {
      re = null;
    }
    regexCache.set(pattern, re);
  }
  return re;
}

/** Apply one entry to `text`. Exposed for the lexicon editor's preview column. */
export function applyEntry(text: string, entry: LexiconEntry): string {
  if (!entry.pattern) return text;
  if (!entry.isRegex) {
    // Plain substring; split/join so "$&" in a replacement stays literal.
    return text.split(entry.pattern).join(entry.replacement);
  }
  const re = regexFor(entry.pattern);
  return re ? text.replace(re, entry.replacement) : text;
}

async function enabledEntries(): Promise<LexiconEntry[]> {
  if (enabledCache) return enabledCache;
  await seedLexicon();
  const all = await db.lexicon.toArray();
  const user = all
    .filter((e) => e.source === 'user' && e.enabled)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const builtin = all
    .filter((e) => e.source === 'builtin' && e.enabled)
    .sort((a, b) => builtinOrder(a.id) - builtinOrder(b.id));
  enabledCache = [...user, ...builtin];
  return enabledCache;
}

/** Rewrite `text` into something a speech engine pronounces correctly. */
export async function expand(text: string): Promise<string> {
  let out = text;
  for (const entry of await enabledEntries()) out = applyEntry(out, entry);
  // Symbol rules emit padded words ("↑" → " increases "); tidy the gaps they leave.
  return out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

/** Short hash of the enabled rules; part of every audio cache key. */
export async function lexiconVersion(): Promise<string> {
  if (versionCache) return versionCache;
  const sig = (await enabledEntries()).map((e) => `${e.pattern}\u0001${e.replacement}`).join('\u0002');
  versionCache = (await sha256Hex(sig)).slice(0, 12);
  return versionCache;
}

// ---------------------------------------------------------------------------
// Editor helpers (used by TtsSettings; keep writes here so the cache stays warm)
// ---------------------------------------------------------------------------

export function newUserEntryId(): string {
  // Timestamp-first ids keep user entries in creation order.
  return `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** All entries in expansion order: user rules first, then the built-ins. */
export async function listLexiconEntries(): Promise<LexiconEntry[]> {
  await seedLexicon();
  const all = await db.lexicon.toArray();
  return [
    ...all.filter((e) => e.source === 'user').sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    ...all.filter((e) => e.source === 'builtin').sort((a, b) => builtinOrder(a.id) - builtinOrder(b.id)),
  ];
}

export async function saveUserEntry(entry: {
  id?: string;
  pattern: string;
  replacement: string;
  isRegex: boolean;
}): Promise<LexiconEntry> {
  const rec: LexiconEntry = {
    id: entry.id ?? newUserEntryId(),
    pattern: entry.pattern,
    replacement: entry.replacement,
    isRegex: entry.isRegex,
    source: 'user',
    enabled: true,
  };
  const prev = entry.id ? await db.lexicon.get(entry.id) : undefined;
  if (prev) rec.enabled = prev.enabled;
  await db.lexicon.put(rec);
  invalidate();
  return rec;
}

export async function deleteUserEntry(id: string): Promise<void> {
  await db.lexicon.delete(id);
  invalidate();
}

export async function setEntryEnabled(id: string, enabled: boolean): Promise<void> {
  await db.lexicon.update(id, { enabled });
  invalidate();
}
