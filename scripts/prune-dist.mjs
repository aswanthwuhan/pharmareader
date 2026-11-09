// transformers.js emits its own hashed copy of the 21.6 MB ORT wasm; runtime loads /ort/ instead (see src/tts/neural/ort.ts).
import { readdirSync, rmSync } from 'node:fs';

const assets = new URL('../dist/assets/', import.meta.url);
for (const name of readdirSync(assets)) {
  if (/^ort-wasm.*\.wasm$/.test(name)) {
    rmSync(new URL(name, assets));
    console.log(`pruned duplicate ${name}`);
  }
}
