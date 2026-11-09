import { describe, expect, it } from 'vitest';
import { DEFAULT_TOPICS, validateTopicTree } from './defaults';
import raw from './nmc-md-pharm.json';

describe('default syllabus data', () => {
  it('is structurally valid', () => {
    expect(validateTopicTree(raw)).toEqual([]);
  });

  it('uses unique slug ids', () => {
    const ids = DEFAULT_TOPICS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('has 20 domains with 4-15 sub-topics each', () => {
    const domains = DEFAULT_TOPICS.filter((t) => t.parentId === null);
    expect(domains).toHaveLength(20);
    for (const domain of domains) {
      const subs = DEFAULT_TOPICS.filter((t) => t.parentId === domain.id);
      expect(subs.length, domain.title).toBeGreaterThanOrEqual(4);
      expect(subs.length, domain.title).toBeLessThanOrEqual(15);
    }
  });

  it('keeps every topic reachable from a domain', () => {
    const ids = new Set(DEFAULT_TOPICS.map((t) => t.id));
    for (const topic of DEFAULT_TOPICS) {
      if (topic.parentId === null) continue;
      expect(ids.has(topic.parentId)).toBe(true);
      expect(DEFAULT_TOPICS.filter((t) => t.id === topic.parentId)[0]?.parentId).toBeNull();
    }
  });

  it('reports every kind of breakage', () => {
    const problems = validateTopicTree([
      { id: 'a', parentId: null, title: 'A', level: 'basic', order: 1 },
      { id: 'a', parentId: 'missing', title: '  ', level: 'expert', order: 2 },
    ]).join('\n');

    expect(problems).toContain('duplicate id: a');
    expect(problems).toContain('missing title');
    expect(problems).toContain('invalid level');
    expect(problems).toContain('parent does not exist');
    expect(validateTopicTree({ nope: true })).toEqual(['topic tree is not an array']);
  });
});
