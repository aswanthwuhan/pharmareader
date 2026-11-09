import { describe, expect, it } from 'vitest';
import { describeNeuralError, messageOf, neuralError } from './neuralError';

describe('neuralError', () => {
  it('keeps the stage of the innermost wrapper', () => {
    const inner = neuralError('kokoro', 'loading the model into memory (q8, wasm)', new Error('no available backend found'));
    const outer = neuralError('kokoro', 'synthesising speech', inner);

    expect(outer.stage).toBe('loading the model into memory (q8, wasm)');
    expect(outer.message).toBe('no available backend found');
  });

  it('describes a failure with the engine and stage a bug report needs', () => {
    const err = neuralError('pocket', 'downloading model files', new Error('Failed to fetch flow_lm_main_int8.onnx: 404'));
    const info = describeNeuralError('pocket', err);

    expect(info.stage).toBe('downloading model files');
    expect(info.message).toContain('404');
    expect(info.details).toContain('engine: pocket');
    expect(info.details).toContain('stage: downloading model files');
    expect(info.details).toContain('--- stack ---');
  });

  it('copes with a thrown non-Error', () => {
    expect(messageOf('boom')).toBe('boom');
    expect(describeNeuralError('kokoro', 'boom').stage).toBe('unknown stage');
    expect(() => neuralError('kokoro', 'x', { code: 1 })).not.toThrow();
  });
});
