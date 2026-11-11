import { describe, expect, it } from 'vitest';
import { cacheKey } from './cache';
import { cacheVoiceId } from './cacheIdentity';

describe('cacheVoiceId', () => {
  it('folds the engine variant into the voice id', async () => {
    expect(await cacheVoiceId({ cacheVariant: () => 'q8' }, 'af_heart')).toBe('af_heart@q8');
    expect(await cacheVoiceId({ cacheVariant: async () => 'fp32' }, 'af_heart')).toBe(
      'af_heart@fp32'
    );
  });

  it('leaves engines without a variant on the plain voice id', async () => {
    expect(await cacheVoiceId({}, 'af_heart')).toBe('af_heart');
    expect(await cacheVoiceId({ cacheVariant: () => undefined }, 'af_heart')).toBe('af_heart');
  });

  it('gives the same sentence different keys at q8 and fp32', async () => {
    // The bug this fixes: the precision was not in the key, so clips rendered with
    // the garbled int8 weights kept playing after switching to fp32.
    const q8 = await cacheKey(
      'Paracetamol 500 mg',
      'kokoro',
      await cacheVoiceId({ cacheVariant: () => 'q8' }, 'af_heart'),
      1
    );
    const fp32 = await cacheKey(
      'Paracetamol 500 mg',
      'kokoro',
      await cacheVoiceId({ cacheVariant: () => 'fp32' }, 'af_heart'),
      1
    );
    expect(q8).not.toBe(fp32);
  });
});
