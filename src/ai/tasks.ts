/**
 * Study tasks built on top of the BYO-key chat client: card generation and
 * summaries of a book selection.
 */
import { AiError, chat } from './client';

export interface GeneratedCard {
  kind: 'qa' | 'cloze';
  front: string;
  back: string;
}

/** Context windows are small on cheap models and pharma chapters are long. */
export const MAX_INPUT_CHARS = 12_000;
export const MAX_CARDS = 20;
/** A flashcard longer than this is a model rambling, not a card. */
export const MAX_CARD_CHARS = 1000;
const MAX_HINT_CHARS = 200;

const TUTOR =
  'You are a pharmacology exam tutor for MD Pharmacology residents in India. ' +
  'You write concise, exam-style study material with exact drug names, mechanisms and numbers.';

const CARD_FORMAT =
  'Answer with JSON only, exactly: {"cards":[{"kind":"qa","front":"...","back":"..."}]}. ' +
  '"kind" is "qa" (front = question, back = short answer) or "cloze" ' +
  '(front = one sentence with the key term replaced by ____, back = the missing term). ' +
  'No commentary, no markdown outside the JSON.';

function truncate(text: string): string {
  return text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;
}

function requireText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new AiError('Select some text first.', 'config');
  return truncate(trimmed);
}

/** NaN/Infinity would end up in the prompt as "Make NaN flashcards". */
function clampCount(value: number | undefined): number {
  const count = Math.trunc(value ?? 5);
  return Number.isFinite(count) ? Math.min(Math.max(count, 1), MAX_CARDS) : 5;
}

export async function generateCards(
  text: string,
  opts: { count?: number; topicHint?: string } = {},
): Promise<GeneratedCard[]> {
  const input = requireText(text);
  const count = clampCount(opts.count);
  const hintText = opts.topicHint?.trim().slice(0, MAX_HINT_CHARS);
  const hint = hintText ? `Topic: ${hintText}\n` : '';

  const raw = await chat(
    [
      { role: 'system', content: TUTOR },
      {
        role: 'user',
        content:
          `${hint}Make ${count} flashcards from this text.\n\n${CARD_FORMAT}\n\nText:\n"""\n${input}\n"""`,
      },
    ],
    { json: true },
  );
  return parseCards(raw);
}

/** Defensive parse: models wrap JSON in fences and sometimes add prose. */
export function parseCards(raw: string): GeneratedCard[] {
  let data: unknown;
  try {
    data = JSON.parse(extractJson(raw));
  } catch {
    throw new AiError('The model did not return valid JSON. Try again.', 'server');
  }

  const list = Array.isArray(data) ? data : (data as { cards?: unknown }).cards;
  if (!Array.isArray(list)) throw new AiError('The model response had no "cards" array. Try again.', 'server');

  const cards: GeneratedCard[] = [];
  for (const item of list) {
    if (cards.length >= MAX_CARDS) break;
    if (!item || typeof item !== 'object') continue;
    const { kind, front, back } = item as { kind?: unknown; front?: unknown; back?: unknown };
    if (kind !== 'qa' && kind !== 'cloze') continue;
    if (typeof front !== 'string' || typeof back !== 'string') continue;
    const f = front.trim().slice(0, MAX_CARD_CHARS);
    const b = back.trim().slice(0, MAX_CARD_CHARS);
    if (!f || !b) continue;
    cards.push({ kind, front: f, back: b });
  }
  if (!cards.length) throw new AiError('The model returned no usable cards. Try again.', 'server');
  return cards;
}

/** Markdown bullet summary: mechanism, uses, ADRs, interactions, key numbers. */
export async function summarize(text: string): Promise<string> {
  const input = requireText(text);
  const raw = await chat([
    { role: 'system', content: TUTOR },
    {
      role: 'user',
      content:
        'Summarise the text below as short markdown bullets for revision. Cover, in this order, ' +
        'only what the text supports: mechanism, uses/indications, adverse drug reactions, ' +
        'interactions, and key numbers (doses, half-life, concentrations). No preamble.\n\n' +
        `Text:\n"""\n${input}\n"""`,
    },
  ]);
  return stripFence(raw).trim();
}

/** Text before the first closing fence, if the model wrapped its answer. */
function stripFence(raw: string): string {
  const fenced = /```(?:markdown|md)?\s*([\s\S]*?)```/i.exec(raw);
  return fenced ? fenced[1] : raw;
}

function extractJson(raw: string): string {
  let s = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fenced && fenced[1].trim()) s = fenced[1].trim();
  if (s.startsWith('{') || s.startsWith('[')) return s;

  const obj = s.indexOf('{');
  const arr = s.indexOf('[');
  const start = obj === -1 ? arr : arr === -1 ? obj : Math.min(obj, arr);
  if (start === -1) return s;
  const end = s[start] === '{' ? s.lastIndexOf('}') : s.lastIndexOf(']');
  return end > start ? s.slice(start, end + 1) : s;
}
