import { db } from '../core/db';
import { DEFAULT_TOPICS } from './defaults';
import { normalizeOrders } from './topics';

/** Writes the shipped tree the first time the app runs. Safe to call on every mount. */
export async function ensureSyllabusSeeded(): Promise<void> {
  if ((await db.topics.count()) > 0) return;
  await db.topics.bulkPut(DEFAULT_TOPICS.map((t) => ({ ...t })));
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
