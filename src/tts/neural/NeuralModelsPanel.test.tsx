import { describe, expect, it } from 'vitest';
import NeuralModelsPanel from './NeuralModelsPanel';

describe('NeuralModelsPanel', () => {
  it('is renderable as a component (imports resolve, CSS module loads)', () => {
    expect(typeof NeuralModelsPanel).toBe('function');
    expect(NeuralModelsPanel.name).toBe('NeuralModelsPanel');
  });
});
