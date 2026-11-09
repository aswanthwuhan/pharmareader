import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';

/** Read one settings row, falling back when it was never written. */
export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await db.settings.get(key);
  return row === undefined ? fallback : (row.value as T);
}

/** Upsert one settings row. */
export async function setSetting(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value });
}

/** Live settings value: re-renders whenever the row changes. */
export function useSetting<T>(key: string, fallback: T): T {
  return useLiveQuery(async () => (await getSetting(key, fallback)), [key], fallback);
}
