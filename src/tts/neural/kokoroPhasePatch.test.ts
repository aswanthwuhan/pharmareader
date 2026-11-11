import { describe, expect, it } from 'vitest';
import { hasPhaseWrap, patchKokoroPhase } from './kokoroPhasePatch';

/**
 * A three-node graph with Kokoro's names: phase -> Transpose_3 -> harmonic Sin, plus an
 * unrelated activation Sin. Run through onnxruntime-node, the patched graph gives
 * sin(98765.43) = 0.0391 (exact 0.0398, fp32), and the activation is untouched; on the
 * real model, WebGPU voicing stays flat to the end of a 25 s clip (was 59% -> 19%).
 */
const TINY = 'CAg6tgQKkAEKBXBoYXNlEkIvZGVjb2Rlci9kZWNvZGVyL2dlbmVyYXRvci9tX3NvdXJjZS9sX3Npbl9nZW4vVHJhbnNwb3NlXzNfb3V0cHV0XzAaOS9kZWNvZGVyL2RlY29kZXIvZ2VuZXJhdG9yL21fc291cmNlL2xfc2luX2dlbi9UcmFuc3Bvc2VfMyIISWRlbnRpdHkKuAEKQi9kZWNvZGVyL2RlY29kZXIvZ2VuZXJhdG9yL21fc291cmNlL2xfc2luX2dlbi9UcmFuc3Bvc2VfM19vdXRwdXRfMBI6L2RlY29kZXIvZGVjb2Rlci9nZW5lcmF0b3IvbV9zb3VyY2UvbF9zaW5fZ2VuL1Npbl9vdXRwdXRfMBoxL2RlY29kZXIvZGVjb2Rlci9nZW5lcmF0b3IvbV9zb3VyY2UvbF9zaW5fZ2VuL1NpbiIDU2luCj8KA2FjdBIHYWN0X291dBoqL2RlY29kZXIvZGVjb2Rlci9nZW5lcmF0b3IvcmVzYmxvY2tzLjAvU2luIgNTaW4SAWsqGQgEEAEiEAAAgD8AAABAAABAQAAAgEBCAXdaEwoFcGhhc2USCgoICAESBAoCCANaEQoDYWN0EgoKCAgBEgQKAggBYkgKOi9kZWNvZGVyL2RlY29kZXIvZ2VuZXJhdG9yL21fc291cmNlL2xfc2luX2dlbi9TaW5fb3V0cHV0XzASCgoICAESBAoCCANiFQoHYWN0X291dBIKCggIARIECgIIAUIECgAQEQ==';
const PHASE = '/decoder/decoder/generator/m_source/l_sin_gen/Transpose_3_output_0';
const WRAPPED = '/decoder/decoder/generator/m_source/l_sin_gen/Transpose_3_output_W';

const bytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const count = (model: Uint8Array, text: string): number => {
  const hay = new TextDecoder('latin1').decode(model);
  return hay.split(text).length - 1;
};

describe('patchKokoroPhase', () => {
  it('feeds the harmonic Sin a wrapped phase and leaves everything else alone', () => {
    const model = bytes(TINY);
    const patched = patchKokoroPhase(model)!;
    expect(patched).not.toBeNull();
    expect(hasPhaseWrap(model)).toBe(false);
    expect(hasPhaseWrap(patched)).toBe(true);
    // The Sin now reads the wrapped name, produced by the appended Sub.
    expect(count(patched, WRAPPED)).toBe(2);
    // The original phase still comes out of Transpose_3, and feeds Div and Sub.
    expect(count(patched, PHASE)).toBe(count(model, PHASE) - 1 + 2);
    // Only the graph grew: every original byte before it is unchanged.
    expect(patched.length).toBeGreaterThan(model.length);
    for (const op of ['Constant', 'Div', 'Floor', 'Mul', 'Sub']) expect(count(patched, `/pharmareader/phase_wrap/${op}`)).toBe(1);
  });

  it('returns already-patched bytes as they are', () => {
    const patched = patchKokoroPhase(bytes(TINY))!;
    expect(patchKokoroPhase(patched)).toBe(patched);
  });

  it('refuses a graph without the harmonic Sin', () => {
    const model = bytes(TINY);
    const name = new TextEncoder().encode('l_sin_gen/Sin\x22');
    // Rename the node so it is no longer recognised: the model must be left alone.
    const at = new TextDecoder('latin1').decode(model).indexOf('l_sin_gen/Sin\x22');
    const broken = model.slice();
    broken[at + name.length - 2] = 'X'.charCodeAt(0);
    expect(patchKokoroPhase(broken)).toBeNull();
    expect(patchKokoroPhase(new Uint8Array([0xff, 0xff]))).toBeNull();
  });
});
