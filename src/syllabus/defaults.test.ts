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

  it('has 26 domains with 3-15 sub-topics each', () => {
    const domains = DEFAULT_TOPICS.filter((t) => t.parentId === null);
    expect(domains).toHaveLength(26);
    for (const domain of domains) {
      const subs = DEFAULT_TOPICS.filter((t) => t.parentId === domain.id);
      expect(subs.length, domain.title).toBeGreaterThanOrEqual(3);
      expect(subs.length, domain.title).toBeLessThanOrEqual(15);
    }
  });

  it('covers the official NMC 2022 syllabus areas', () => {
    // Broad topics from the NMC MD Pharmacology 2022 guidelines (pages 10-13).
    const titles = DEFAULT_TOPICS.map((t) => `${t.title} ${t.id}`.toLowerCase()).join('\n');
    for (const needle of [
      'history of pharmacology',
      'molecular pharmacology',
      'synaptic',
      'therapeutic drug monitoring',
      'pharmacoepidemiology',
      'drug utilisation',
      'pharmacovigilance',
      'essential medicines',
      'otc',
      'dmards',
      'gout',
      'autoimmune',
      'reproductive',
      'uterine',
      'calcium',
      'drug delivery',
      'dietary supplements',
      'herbal',
      'poisoning',
      'pesticides',
      'national tb',
      'vector-borne',
      'disinfectants',
      'good clinical practice',
      'drugs & cosmetics act',
      'emergency use authorisation',
      'pharmacometrics',
      'screening methods',
      'pd2',
      'computer',
      'anaesthesia of laboratory animals',
      'research protocol',
      'literature search',
      'professionalism',
      'counselling',
      'medical education in india',
      'dispensing',
      'hospital formulary',
      'drugs & therapeutics committee',
      'medication errors',
      'colorimetry',
      'chromatography',
      'elisa',
    ]) {
      expect(titles, needle).toContain(needle);
    }
  });

  it('keeps historical topic ids stable for bookmarks and cards', () => {
    const ids = new Set(DEFAULT_TOPICS.map((t) => t.id));
    // Legacy ids that existing topic tags on books/cards may reference.
    for (const id of [
      'misc-vitamins',
      'misc-chelators',
      'misc-dermatological',
      'misc-ocular',
      'misc-vaccines',
      'misc-toxicology',
      'misc-antidotes',
      'gp-absorption-distribution',
      'end-pituitary',
      'ct-gcp',
    ]) {
      expect(ids.has(id), id).toBe(true);
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
