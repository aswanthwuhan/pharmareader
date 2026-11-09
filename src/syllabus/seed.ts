import { db } from '../core/db';
import { getSetting, setSetting } from '../core/settings';
import { DEFAULT_TOPICS } from './defaults';
import { normalizeOrders } from './topics';

/** Bump when nmc-md-pharm.json gains topics, so existing installs pick them up once. */
export const SEED_VERSION = 2;
const SEED_KEY = 'syllabus.seedVersion';

let seeding: Promise<void> | null = null;

/**
 * Writes the shipped tree on first run; after an app update with a newer SEED_VERSION, adds
 * only the default topics the device lacks. Existing rows (user renames/levels/moves) are never
 * overwritten, and built-in topics the user deleted stay deleted until the next version bump.
 */
export async function ensureSyllabusSeeded(): Promise<void> {
  // Two mounts (StrictMode, or the syllabus page and a picker on one screen) would otherwise
  // read the same empty table and race each other's write; one of them would fail outright.
  seeding ??= seedOnce().finally(() => {
    seeding = null;
  });
  return seeding;
}

async function seedOnce(): Promise<void> {
  if ((await getSetting<number>(SEED_KEY, 0)) >= SEED_VERSION) return;
  const have = new Set(await db.topics.toCollection().primaryKeys());
  const missing = DEFAULT_TOPICS.filter((t) => !have.has(t.id));
  if (missing.length > 0) await db.topics.bulkPut(missing.map((t) => ({ ...t })));
  await setSetting(SEED_KEY, SEED_VERSION);
}

/**
 * Puts the built-in tree back. Topics the user created (`custom: true`) survive,
 * because "reset" means "undo my edits to the syllabus", not "delete my work".
 */
export async function resetToDefault(): Promise<void> {
  const custom = await db.topics.filter((t) => t.custom === true).toArray();
  await db.transaction('rw', db.topics, async () => {
    await db.topics.clear();
    await db.topics.bulkPut(DEFAULT_TOPICS.map((t) => ({ ...t })));
    if (custom.length > 0) await db.topics.bulkPut(custom);
  });
  await normalizeOrders();
}
