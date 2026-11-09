import { describe, expect, it } from 'vitest';
import { describeKokoroFailure, errorCode, stageLabel } from './kokoroFailure';
import type { KokoroStatus } from './kokoroPlugin';

const AT = new Date('2026-11-09T12:00:00.000Z');

const STATUS: KokoroStatus = {
  downloaded: false,
  loaded: false,
  sizeBytes: 0,
  partialBytes: 80 * 1024 * 1024,
  freeBytes: 1024 * 1024 * 1024,
  requiredBytes: 769_886_476,
  archiveBytes: 349_886_476,
  modelId: 'kokoro-multi-lang-v1_0',
};

describe('stageLabel', () => {
  it('names every stage as a phrase that reads inside a sentence', () => {
    expect(stageLabel('download')).toBe('downloading the 334 MB model');
    expect(stageLabel('unpack')).toBe('unpacking the model archive');
    expect(stageLabel('load')).toBe('loading the model into memory');
  });
});

describe('errorCode', () => {
  it('reads the Capacitor reject code', () => {
    const err = Object.assign(new Error('Download failed: HTTP 403'), { code: 'DOWNLOAD_FAILED' });
    expect(errorCode(err)).toBe('DOWNLOAD_FAILED');
  });

  it('is undefined for plain errors and non-strings', () => {
    expect(errorCode(new Error('boom'))).toBeUndefined();
    expect(errorCode('boom')).toBeUndefined();
    expect(errorCode({ code: 42 })).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
  });
});

describe('describeKokoroFailure', () => {
  it('names the stage in the message so the panel says where it broke', () => {
    const failure = describeKokoroFailure(
      'unpack',
      new Error('The model archive could not be unpacked (Unexpected end of ZLIB') ,
      STATUS,
      AT
    );
    expect(failure.stage).toBe('unpack');
    expect(failure.message).toBe(
      'Unpacking the model archive failed: The model archive could not be unpacked ' +
        '(Unexpected end of ZLIB'
    );
  });

  it('keeps the numbers that explain the failure in the copyable block', () => {
    const failure = describeKokoroFailure(
      'download',
      Object.assign(new Error('HTTP 403 while downloading the model'), { code: 'DOWNLOAD_FAILED' }),
      STATUS,
      AT
    );
    expect(failure.details).toContain('stage: download (downloading the 334 MB model)');
    expect(failure.details).toContain('error: HTTP 403 while downloading the model');
    expect(failure.details).toContain('code: DOWNLOAD_FAILED');
    expect(failure.details).toContain('time: 2026-11-09T12:00:00.000Z');
    expect(failure.details).toContain('partial download: 80.0 MB');
    expect(failure.details).toContain('free storage: 1024 MB');
    expect(failure.details).toContain('archive size: 334 MB');
    expect(failure.details).toContain('downloaded: no');
  });

  it('still produces a copyable block when the status call failed too', () => {
    const failure = describeKokoroFailure('status', new Error('Kokoro plugin is shutting down'), null, AT);
    expect(failure.message).toBe(
      'Reading the model state failed: Kokoro plugin is shutting down'
    );
    expect(failure.details).toContain('model state: unknown (the status call itself failed)');
    expect(failure.details).toContain('code: none');
  });

  it('does not print an empty message for a rejection without text', () => {
    const failure = describeKokoroFailure('load', { code: 'LOAD_FAILED' }, STATUS, AT);
    expect(failure.message).toBe('Loading the model into memory failed: {"code":"LOAD_FAILED"}');
  });

  it('falls back to the error name when the message is empty', () => {
    expect(describeKokoroFailure('measure', new Error(''), STATUS, AT).message).toBe(
      'Measuring speech speed failed: Error'
    );
  });
});
