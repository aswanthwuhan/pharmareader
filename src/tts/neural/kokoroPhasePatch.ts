/**
 * Keep Kokoro's voice from turning into a whisper on WebGPU.
 *
 * Kokoro's vocoder builds its voiced sound from `sin(phase)`, where the phase is a
 * running sum over the whole clip (`m_source/l_sin_gen`: CumSum → ×2π → ×upsample →
 * Resize → Sin). A few seconds into a clip that phase is ~10⁵ radians. CPU and WASM
 * evaluate sin() of such a number correctly; GPU sin() does not, so on WebGPU the
 * harmonics decay into noise and the voice goes breathy partway through a sentence
 * (measured: 79% voiced at the start of a 13 s clip, 12% at the end; WASM stays flat).
 *
 * The fix is one wrap in the graph: `phase - 2π·floor(phase / 2π)` right before that
 * Sin. sin() of the wrapped value is the same number, but now always in [0, 2π), where
 * GPU sin() is accurate. This file edits the ONNX bytes directly (no protobuf
 * library): it renames the Sin node's input to an equally long name, so nothing
 * inside the graph moves, and appends five nodes that compute the wrap into that
 * name. Only the graph's length prefix changes. Exports differ in node names
 * (`/decoder/generator/…` vs `/decoder/decoder/generator/…`), so the Sin is found
 * by op type and name suffix, not by exact bytes.
 */

/** The harmonic source's Sin; every other Sin in the vocoder is an activation. */
const SIN_SUFFIX = '/m_source/l_sin_gen/Sin';
/** Marks the wrapped phase; also how an already-patched model is recognised. */
const PREFIX = '/pharmareader/phase_wrap/';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function varint(value: number): number[] {
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return out;
}

function readVarint(bytes: Uint8Array, at: number): [value: number, next: number] {
  let value = 0;
  let scale = 1;
  let i = at;
  for (;;) {
    if (i >= bytes.length) throw new Error('Truncated varint');
    const byte = bytes[i++]!;
    value += (byte & 0x7f) * scale;
    if (byte < 0x80) return [value, i];
    scale *= 0x80;
  }
}

interface Field {
  key: number;
  /** Offset of the field's tag. */
  start: number;
  /** Payload bounds (length-delimited fields only). */
  from: number;
  to: number;
}

/** The fields of one protobuf message in `bytes[from, to)`, or null if it does not parse. */
function fields(bytes: Uint8Array, from: number, to: number): Field[] | null {
  const out: Field[] = [];
  let at = from;
  while (at < to) {
    const start = at;
    const [key, afterKey] = readVarint(bytes, at);
    const wire = key & 7;
    if (wire === 0) {
      at = readVarint(bytes, afterKey)[1];
      out.push({ key, start, from: afterKey, to: at });
    } else if (wire === 2) {
      const [length, afterLength] = readVarint(bytes, afterKey);
      at = afterLength + length;
      out.push({ key, start, from: afterLength, to: at });
    } else if (wire === 1) at = afterKey + 8;
    else if (wire === 5) at = afterKey + 4;
    else return null;
    if (at > to) return null;
  }
  return out;
}

function field(tag: number, payload: number[] | Uint8Array): number[] {
  return [...varint(tag), ...varint(payload.length), ...payload];
}

function str(tag: number, text: string): number[] {
  return field(tag, encoder.encode(text));
}

/** NodeProto: input = 1, output = 2, name = 3, op_type = 4, attribute = 5. */
function node(op: string, inputs: string[], output: string, attribute: number[] = []): number[] {
  const body = [
    ...inputs.flatMap((name) => str(0x0a, name)),
    ...str(0x12, output),
    ...str(0x1a, `${PREFIX}${op}`),
    ...str(0x22, op),
    ...(attribute.length ? field(0x2a, attribute) : []),
  ];
  return field(0x0a, body); // GraphProto.node = 1
}

function wrapNodes(phase: string, wrapped: string): Uint8Array {
  const twoPi = `${PREFIX}two_pi`;
  const value = new Uint8Array(new Float32Array([2 * Math.PI]).buffer);
  // TensorProto{data_type = FLOAT, raw_data}; AttributeProto{name, t, type = TENSOR}.
  const tensor = [0x10, 1, ...field(0x4a, value)];
  const attribute = [...str(0x0a, 'value'), ...field(0x2a, tensor), 0xa0, 0x01, 4];
  return Uint8Array.from([
    ...node('Constant', [], twoPi, attribute),
    ...node('Div', [phase, twoPi], `${PREFIX}turns`),
    ...node('Floor', [`${PREFIX}turns`], `${PREFIX}whole_turns`),
    ...node('Mul', [`${PREFIX}whole_turns`, twoPi], `${PREFIX}whole_phase`),
    ...node('Sub', [phase, `${PREFIX}whole_phase`], wrapped),
  ]);
}

function text(bytes: Uint8Array, f: Field): string {
  return decoder.decode(bytes.subarray(f.from, f.to));
}

/**
 * Return the model with the phase wrapped before the harmonic Sin, or `null` when the
 * graph is not one this patch understands (then the model must be used unchanged).
 * Already-patched bytes come back as they are.
 */
export function patchKokoroPhase(model: Uint8Array): Uint8Array | null {
  try {
    return patch(model);
  } catch {
    return null; // bytes that are not a protobuf this walker can read
  }
}

function patch(model: Uint8Array): Uint8Array | null {
  const top = fields(model, 0, model.length);
  const graph = top?.find((f) => f.key === 0x3a); // ModelProto.graph = 7
  if (!graph) return null;
  const graphFields = fields(model, graph.from, graph.to);
  if (!graphFields) return null;

  let sinInput: Field | null = null;
  for (const entry of graphFields) {
    if (entry.key !== 0x0a) continue; // GraphProto.node = 1
    const parts = fields(model, entry.from, entry.to);
    if (!parts) return null;
    const name = parts.find((f) => f.key === 0x1a);
    if (name && text(model, name).startsWith(PREFIX)) return model; // already patched
    const op = parts.find((f) => f.key === 0x22);
    if (!op || text(model, op) !== 'Sin' || !name || !text(model, name).endsWith(SIN_SUFFIX)) continue;
    const inputs = parts.filter((f) => f.key === 0x0a);
    if (inputs.length !== 1 || sinInput) return null; // not the graph this was written for
    sinInput = inputs[0]!;
  }
  if (!sinInput || sinInput.to === sinInput.from) return null;

  const phase = text(model, sinInput);
  // Same length as the original name, so renaming moves no other byte.
  const wrapped = `${phase.slice(0, -1)}${phase.endsWith('W') ? 'V' : 'W'}`;
  const extra = wrapNodes(phase, wrapped);

  const graphLength = graph.to - graph.from + extra.length;
  const header = Uint8Array.from([0x3a, ...varint(graphLength)]);
  const out = new Uint8Array(graph.start + header.length + graphLength + (model.length - graph.to));
  out.set(model.subarray(0, graph.start), 0);
  out.set(header, graph.start);
  out.set(model.subarray(graph.from, graph.to), graph.start + header.length);
  out.set(extra, graph.start + header.length + (graph.to - graph.from));
  out.set(model.subarray(graph.to), graph.start + header.length + graphLength);
  // Point the Sin at the wrapped phase: the last character of its input name.
  out[graph.start + header.length + (sinInput.to - 1 - graph.from)] = wrapped.charCodeAt(wrapped.length - 1);
  return out;
}

/** Whether these model bytes already carry the wrap. */
export function hasPhaseWrap(model: Uint8Array): boolean {
  const needle = encoder.encode(`${PREFIX}Sub`);
  outer: for (let i = 0; i <= model.length - needle.length; i++) {
    if (model[i] !== needle[0]) continue;
    for (let j = 1; j < needle.length; j++) if (model[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * Patch the weights transformers.js keeps in Cache Storage, in place, once. Returns true
 * when it rewrote the entry — the session that is already loaded is then the unpatched
 * model and must be created again. Anything unexpected (no cache, no entry, a graph this
 * patch does not recognise) leaves the cache untouched and returns false.
 */
export async function patchCachedKokoroModel(url: string): Promise<boolean> {
  if (typeof caches === 'undefined') return false;
  const cache = await caches.open('transformers-cache');
  const cached = await cache.match(url);
  if (!cached) return false;
  // The marker holds the patched size: reading 325 MB on every launch just to find the
  // wrap already there would cost seconds, and a re-download leaves a different size.
  const marker = `${url}?pharmareader-phase-wrap`;
  const done = await cache.match(marker);
  if (done && (await done.text()) === cached.headers.get('content-length')) return false;
  const original = new Uint8Array(await cached.arrayBuffer());
  const patched = patchKokoroPhase(original);
  if (!patched) return false;
  if (patched === original) {
    await cache.put(marker, new Response(String(original.length)));
    return false;
  }
  const headers = new Headers(cached.headers);
  headers.set('content-length', String(patched.length));
  await cache.put(url, new Response(patched as Uint8Array<ArrayBuffer>, { status: 200, headers }));
  await cache.put(marker, new Response(String(patched.length)));
  return true;
}
