import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getDownload,
  isDownloadRunning,
  resetDownload,
  startDownload,
  subscribe,
  type DownloadReporter,
  type DownloadState,
} from './downloads';

/**
 * These use their own ids: the store is module state shared by every test in the
 * file, exactly like the app shares it across screens.
 */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (err: unknown) => void } {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startDownload', () => {
  it('runs one download and gives a second caller the same promise', async () => {
    const gate = deferred();
    let runs = 0;
    const run = async (report: DownloadReporter): Promise<void> => {
      runs += 1;
      report({ fraction: 0.4 });
      await gate.promise;
    };

    const first = startDownload('dedupe', run);
    const second = startDownload('dedupe', run);
    await tick();

    expect(second).toBe(first);
    expect(runs).toBe(1);
    expect(getDownload('dedupe')).toMatchObject({ status: 'downloading', fraction: 0.4 });

    gate.resolve();
    await first;
    expect(getDownload('dedupe')).toMatchObject({ status: 'done', fraction: 1 });
    expect(isDownloadRunning('dedupe')).toBe(false);
  });

  it('tells every subscriber the same progress', async () => {
    const seenA: DownloadState[] = [];
    const seenB: DownloadState[] = [];
    subscribe('fanout', () => seenA.push(getDownload('fanout')));
    subscribe('fanout', () => seenB.push(getDownload('fanout')));

    await startDownload('fanout', async (report) => {
      report({ fraction: 0.25 });
      report({ fraction: 0.75 });
    });

    expect(seenA.map((state) => state.fraction)).toEqual([0, 0.25, 0.75, 1]);
    expect(seenB).toEqual(seenA);
  });

  it('keeps the failure, its cause and the stage instead of rejecting', async () => {
    const boom = new Error('Failed to fetch');
    await expect(startDownload('failure', async () => {
      throw boom;
    })).resolves.toBeUndefined();

    const state = getDownload('failure');
    expect(state.status).toBe('error');
    expect(state.error).toBe('Failed to fetch');
    expect(state.cause).toBe(boom);
    expect(isDownloadRunning('failure')).toBe(false);
  });

  it('describes a rejection that is not an Error', async () => {
    await startDownload('odd-failure', async () => {
      throw 'Cache Storage is full';
    });

    expect(getDownload('odd-failure')).toMatchObject({
      status: 'error',
      error: 'Cache Storage is full',
    });
  });

  it('records a run that throws before it yields', async () => {
    // `run` is invoked in a microtask, so a synchronous throw is a failed
    // download instead of an exception thrown out of the click handler.
    let started = false;
    await startDownload('sync-failure', (report) => {
      started = true;
      report({ fraction: 0.3 });
      throw new Error('no engine');
    });

    expect(started).toBe(true);
    expect(getDownload('sync-failure')).toMatchObject({
      status: 'error',
      error: 'no engine',
      fraction: 0.3,
    });
    expect(isDownloadRunning('sync-failure')).toBe(false);
  });

  it('shows a late subscriber where the download already is', async () => {
    const gate = deferred();
    const task = startDownload('late', async (report) => {
      report({ fraction: 0.6 });
      await gate.promise;
    });
    await tick();
    expect(getDownload('late').fraction).toBe(0.6);

    const seen: number[] = [];
    subscribe('late', () => seen.push(getDownload('late').fraction));
    expect(getDownload('late').fraction).toBe(0.6);

    gate.resolve();
    await task;
    expect(seen).toEqual([1]);
  });

  it('reports unpacking and loading as work still in progress', async () => {
    const gate = deferred();
    const task = startDownload('stages', async (report) => {
      report({ fraction: 1 });
      report({ stage: 'unpack' });
      report({ stage: 'load' });
      await gate.promise;
    });
    await tick();

    expect(getDownload('stages')).toMatchObject({
      status: 'unpacking',
      fraction: 1,
      stage: 'load',
    });

    gate.resolve();
    await task;
    expect(getDownload('stages')).toMatchObject({ status: 'done', stage: 'load' });
  });

  it('never moves the bar backwards when a resumed transfer restarts its counter', async () => {
    const gate = deferred();
    const task = startDownload('monotonic', async (report) => {
      report({ fraction: 0.8 });
      report({ fraction: 0.1 });
      await gate.promise;
    });
    await tick();

    expect(getDownload('monotonic').fraction).toBe(0.8);
    gate.resolve();
    await task;
  });

  it('ignores progress that arrives after the run ended', async () => {
    const gate = deferred();
    let late: DownloadReporter | undefined;
    const task = startDownload('late-report', async (report) => {
      late = report;
      await gate.promise;
    });
    await tick();
    gate.resolve();
    await task;
    expect(getDownload('late-report').status).toBe('done');

    late?.({ fraction: 0.2 });
    expect(getDownload('late-report')).toMatchObject({ status: 'done', fraction: 1 });
  });

  it('starts again once the previous run finished, including after a failure', async () => {
    await startDownload('again', async () => {
      throw new Error('first attempt');
    });
    expect(getDownload('again').status).toBe('error');

    let runs = 0;
    await startDownload('again', async () => {
      runs += 1;
    });
    expect(runs).toBe(1);
    expect(getDownload('again').status).toBe('done');
  });
});

describe('subscribe', () => {
  it('stops calling a listener that unsubscribed', async () => {
    const calls: number[] = [];
    const unsubscribe = subscribe('unsub', () => calls.push(getDownload('unsub').fraction));
    unsubscribe();

    await startDownload('unsub', async (report) => {
      report({ fraction: 0.5 });
    });

    expect(calls).toEqual([]);
  });
});

describe('resetDownload', () => {
  it('forgets a finished download', async () => {
    await startDownload('reset', async () => undefined);
    expect(getDownload('reset').status).toBe('done');

    resetDownload('reset');
    expect(getDownload('reset')).toEqual({ status: 'idle', fraction: 0, stage: 'download' });
  });

  it('never claims a running download is gone', async () => {
    const gate = deferred();
    const task = startDownload('reset-running', async () => {
      await gate.promise;
    });
    await tick();

    resetDownload('reset-running');
    expect(getDownload('reset-running').status).toBe('downloading');

    gate.resolve();
    await task;
  });
});
