import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../core/db';
import { DEFAULT_TOPICS } from './defaults';
import { ensureSyllabusSeeded, resetToDefault } from './seed';
import { addSubtopic } from './topics';

afterEach(async () => {
  await db.delete();
  await db.open();
});

describe('ensureSyllabusSeeded', () => {
  it('inserts the default tree once and is idempotent', async () => {
    await ensureSyllabusSeeded();
    const first = await db.topics.toArray();
    expect(first).toHaveLength(DEFAULT_TOPICS.length);

    await ensureSyllabusSeeded();
    const second = await db.topics.toArray();
    expect(second).toHaveLength(DEFAULT_TOPICS.length);
    expect(second.map((t) => t.id).sort()).toEqual(first.map((t) => t.id).sort());
  });

  it('upgrades an older syllabus by adding missing defaults without touching existing rows', async () => {
    await db.topics.put({ id: 'mine', parentId: null, title: 'My own domain', level: 'basic', order: 1, custom: true });
    await db.topics.put({ ...DEFAULT_TOPICS[0], title: 'Renamed by me' });
    await ensureSyllabusSeeded();
    expect(await db.topics.count()).toBe(DEFAULT_TOPICS.length + 1);
    expect((await db.topics.get('mine'))?.title).toBe('My own domain');
    expect((await db.topics.get(DEFAULT_TOPICS[0].id))?.title).toBe('Renamed by me');
  });

  it('does not resurrect a deleted built-in topic on the next launch', async () => {
    await ensureSyllabusSeeded();
    await db.topics.delete('cvs-antianginals');
    await ensureSyllabusSeeded();
    expect(await db.topics.get('cvs-antianginals')).toBeUndefined();
  });

  it('survives two mounts seeding at the same time', async () => {
    await Promise.all([ensureSyllabusSeeded(), ensureSyllabusSeeded()]);
    expect(await db.topics.count()).toBe(DEFAULT_TOPICS.length);
  });
});

describe('resetToDefault', () => {
  it('restores edited and deleted defaults but keeps custom topics', async () => {
    await ensureSyllabusSeeded();
    await db.topics.update('cvs-antihypertensives', { title: 'Renamed by me', level: 'advanced' });
    await db.topics.delete('cvs-antianginals');
    const customId = await addSubtopic('cvs-antihypertensives', 'My own subtopic', 'advanced');

    await resetToDefault();

    expect((await db.topics.get('cvs-antihypertensives'))?.title).toBe('Antihypertensives');
    expect((await db.topics.get('cvs-antihypertensives'))?.level).toBe('intermediate');
    expect(await db.topics.get('cvs-antianginals')).toBeTruthy();

    const custom = await db.topics.get(customId);
    expect(custom).toMatchObject({ title: 'My own subtopic', parentId: 'cvs-antihypertensives', custom: true });

    for (const topic of DEFAULT_TOPICS) expect(await db.topics.get(topic.id)).toBeTruthy();
    expect(await db.topics.count()).toBe(DEFAULT_TOPICS.length + 1);
  });

  it('renumbers siblings after merging custom topics back in', async () => {
    await ensureSyllabusSeeded();
    const customId = await addSubtopic('cvs-antihypertensives', 'Extra', 'basic');
    await resetToDefault();

    const siblings = await db.topics.where('parentId').equals('cvs-antihypertensives').toArray();
    const orders = siblings.map((t) => t.order).sort((a, b) => a - b);
    expect(orders).toEqual(siblings.map((_, i) => i + 1));
    expect(siblings.some((t) => t.id === customId)).toBe(true);
  });
});
