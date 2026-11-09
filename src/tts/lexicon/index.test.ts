import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../../core/db';
import {
  BUILTIN_LEXICON,
  applyEntry,
  deleteUserEntry,
  expand,
  invalidate,
  lexiconVersion,
  listLexiconEntries,
  saveUserEntry,
  seedLexicon,
  setEntryEnabled,
} from './index';

afterEach(async () => {
  await db.delete();
  await db.open();
  invalidate();
});

describe('seedLexicon', () => {
  it('writes every built-in entry once, with positional ids', async () => {
    await seedLexicon();
    await seedLexicon(); // second call must not duplicate

    const rows = await db.lexicon.where('source').equals('builtin').toArray();
    expect(rows).toHaveLength(BUILTIN_LEXICON.length);
    expect(rows.every((r) => /^b-\d+$/.test(r.id))).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(150);
  });

  it('re-seeds changed built-ins but keeps the user toggle and user rows', async () => {
    await seedLexicon();
    await setEntryEnabled('b-1', false);
    await saveUserEntry({ pattern: 'CYP', replacement: 'C Y P', isRegex: true });

    // Simulate a bundled lexicon update by corrupting one stored row.
    await db.lexicon.update('b-2', { pattern: 'stale-pattern' });
    invalidate();
    await seedLexicon();

    expect((await db.lexicon.get('b-1'))?.enabled).toBe(false);
    expect((await db.lexicon.get('b-2'))?.pattern).toBe(BUILTIN_LEXICON[1]?.pattern);
    expect((await db.lexicon.where('source').equals('user').count())).toBe(1);
  });
});

describe('expand', () => {
  const cases: [string, string][] = [
    ['t½ of digoxin is 36 h', 'half-life of digoxin is 36 hours'],
    ['CYP3A4 inhibitors', 'C Y P three A four inhibitors'],
    ['Ca²⁺', 'calcium two plus'],
    ['5 mg/kg i.v.', '5 milligrams per kilogram intravenous'],
    ['EC₅₀', 'E C fifty'],
    ['β₂ agonist', 'beta two agonist'],
    ['Na⁺/K⁺-ATPase', 'sodium potassium A T Pase'],
    ['0.5 mg/kg/h', '0.5 milligrams per kilogram per hour'],
    ['10 mg/kg/day', '10 milligrams per kilogram per day'],
    ['50 µg/m²', '50 micrograms per square meter'],
    ['F 80%', 'bioavailability 80 percent'],
    ['2 μg/mL', '2 micrograms per milliliter'],
    ['500 mL of saline', '500 milliliters of saline'],
    ['40 mmHg', '40 millimeters of mercury'],
    ['250 mg b.d.', '250 milligrams twice daily'],
    ['t.i.d. after meals', 'three times daily after meals'],
    ['q.d. at HS', 'once daily at bedtime'],
    ['h/hr', 'hours'],
    ['10 U insulin', '10 units insulin'],
    ['50% of patients', '50 percent of patients'],
    ['dose ≥ 5 mg', 'dose greater than or equal to 5 milligrams'],
    ['0.5–2 mg', '0.5 to 2 milligrams'],
    ['NSAIDs', 'N S A I D'],
    ['5-HT3 antagonist', 'five H T three antagonist'],
    ['α and β receptors', 'alpha and beta receptors'],
    ['CYP2D6 poor metaboliser', 'C Y P two D six poor metaboliser'],
    ['P-gp efflux', 'P glycoprotein efflux'],
    ['1.5 L', '1.5 liters'],
    ['pH 7.4', 'pH 7.4'],
    ['The half-life of CYP3A4 substrates rises with ketoconazole.', 'The half-life of C Y P three A four substrates rises with ketoconazole.'],
  ];

  for (const [input, want] of cases) {
    it(`expands ${JSON.stringify(input)}`, async () => {
      expect(await expand(input)).toBe(want);
    });
  }

  it('expands arrows and percent without leaving doubled spaces', async () => {
    expect(await expand('hypotension → syncope')).toBe('hypotension leads to syncope');
    expect(await expand('BP↑, HR↓')).toBe('BP increases, HR decreases');
  });
});

describe('user entries', () => {
  it('runs user rules before built-ins and can be deleted', async () => {
    await seedLexicon();
    const e = await saveUserEntry({ pattern: '\\bKD\\b', replacement: 'K D value', isRegex: true });

    expect(await expand('KD 0.5 nM')).toBe('K D value 0.5 nanomolar');

    await deleteUserEntry(e.id);
    // No built-in rule for the uppercase form, so it now passes through untouched.
    expect(await expand('KD')).toBe('KD');
  });

  it('supports plain-text entries with regex-special replacements', async () => {
    await seedLexicon();
    await saveUserEntry({ pattern: 'cost $5', replacement: '$5 only', isRegex: false });
    expect(await expand('cost $5 per pill')).toBe('$5 only per pill');
  });

  it('toggles a built-in off, which also changes the lexicon version', async () => {
    await seedLexicon();
    const before = await lexiconVersion();
    const halfLife = BUILTIN_LEXICON.findIndex((e) => e.pattern.includes('½'));
    await setEntryEnabled(`b-${halfLife + 1}`, false);
    const after = await lexiconVersion();
    expect(after).not.toBe(before);
    // The generic ½ → "half" rule still applies; only the half-life rule is off.
    expect(await expand('t½ of digoxin')).toBe('t half of digoxin');
  });

  it('ignores a broken regex instead of throwing', async () => {
    await seedLexicon();
    await saveUserEntry({ pattern: '([unclosed', replacement: 'x', isRegex: true });
    expect(await expand('safe text')).toBe('safe text');
  });

  it('lists user entries before built-ins', async () => {
    await seedLexicon();
    const e = await saveUserEntry({ pattern: 'zzz', replacement: 'Z', isRegex: false });
    const rows = await listLexiconEntries();
    expect(rows[0]?.id).toBe(e.id);
    expect(rows[1]?.id).toBe('b-1');
  });
});

describe('applyEntry', () => {
  it('replaces every occurrence, not just the first', () => {
    const entry = { id: 'x', pattern: 'mg', replacement: 'milligrams', isRegex: false, source: 'user' as const, enabled: true };
    expect(applyEntry('1 mg, 2 mg', entry)).toBe('1 milligrams, 2 milligrams');
  });
});
