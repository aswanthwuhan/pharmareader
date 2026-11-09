import type { Topic } from '../core/types';
import raw from './nmc-md-pharm.json';

/** The shipped tree is data, not code: keep it in JSON so it can be edited without touching logic. */
export const LEVELS: readonly Topic['level'][] = ['basic', 'intermediate', 'advanced'];

type RawTopic = {
  id?: unknown;
  parentId?: unknown;
  title?: unknown;
  level?: unknown;
  order?: unknown;
};

/**
 * Structural checks shared by the seed and the tests. Returns human-readable
 * problems (empty array = valid) so a bad hand-edit of the JSON fails a test
 * instead of silently producing an unreachable branch of the tree.
 */
export function validateTopicTree(input: unknown): string[] {
  if (!Array.isArray(input)) return ['topic tree is not an array'];
  const problems: string[] = [];
  const ids = new Set<string>();

  for (const item of input) {
    const t = item as RawTopic;
    if (typeof t.id !== 'string' || t.id.length === 0) problems.push(`topic without a string id`);
    else if (ids.has(t.id)) problems.push(`duplicate id: ${t.id}`);
    else ids.add(t.id);
  }

  for (const item of input) {
    const t = item as RawTopic;
    const name = typeof t.id === 'string' ? t.id : '(no id)';
    if (typeof t.title !== 'string' || t.title.trim().length === 0) problems.push(`missing title: ${name}`);
    if (!LEVELS.includes(t.level as Topic['level'])) problems.push(`invalid level: ${name} -> ${String(t.level)}`);
    if (typeof t.order !== 'number' || !Number.isFinite(t.order)) problems.push(`missing order: ${name}`);
    if (t.parentId !== null && (typeof t.parentId !== 'string' || !ids.has(t.parentId))) {
      problems.push(`parent does not exist: ${name} -> ${String(t.parentId)}`);
    }
  }
  return problems;
}

/** Default MD Pharmacology tree (India, modelled on the NMC competency-based curriculum). */
export const DEFAULT_TOPICS: Topic[] = (raw as RawTopic[]).map((t) => ({
  id: t.id as string,
  parentId: (t.parentId ?? null) as string | null,
  title: t.title as string,
  level: t.level as Topic['level'],
  order: t.order as number,
}));
