// Downloads native Android deps kept out of git (sherpa-onnx AAR is 50 MB) and verifies SHA-256.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const dir = new URL('../android/app/libs/', import.meta.url);
const libs = [
  ['sherpa-onnx-1.13.8.aar', 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-1.13.8.aar', '633c24321e06b1fe79feafa03ea16cbc0f8a286641e2da3559bac91bdb13bd96'],
  ['commons-compress-1.26.2.jar', 'https://repo1.maven.org/maven2/org/apache/commons/commons-compress/1.26.2/commons-compress-1.26.2.jar', '9168a03141d8fc7eda21a2360d83cc0412bcbb1d6204d992bd48c2573cb3c6b8'],
];
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

mkdirSync(dir, { recursive: true });
for (const [name, url, want] of libs) {
  const file = new URL(name, dir);
  if (existsSync(file) && sha(readFileSync(file)) === want) continue;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha(buf) !== want) throw new Error(`${name}: checksum mismatch`);
  writeFileSync(file, buf);
  console.log(`fetched ${name}`);
}
