/**
 * Read-along highlight: the mark on the sentence the voice is speaking.
 *
 * The mark is a wash behind the words, or a 2px rule under them — never a box
 * drawn around the text. The reader picks the colour and the strength; the
 * style switch decides which of the two marks is used.
 *
 * The word being read gets its own, stronger mark of the same colour inside
 * that wash (or the old 2px rule, if the reader prefers it) at its own
 * strength.
 *
 * ReaderView puts the values on the page root as `--ra-color`, `--ra-ink`,
 * `--ra-alpha` and `--ra-word-alpha`, plus `data-ra-style` and `data-ra-word`,
 * and reader.css paints every sentence, spoken word and PDF rect from them.
 * The controls themselves are ReadAlongGroup.tsx, rendered by the reader's
 * "Aa" sheet and by Settings → Reading aloud so the two never drift apart.
 */
import type { CSSProperties } from 'react';
import { useSetting } from '../core/settings';

/** Which mark the sentence being spoken gets. */
export type ReadAlongStyle = 'fill' | 'underline';

/** Which mark the word being spoken gets, inside that sentence. */
export type ReadAlongWordStyle = 'highlight' | 'underline';

/** The mark colours. Each maps to a theme token; no hex value lives here. */
export type ReadAlongColour = 'yellow' | 'green' | 'blue' | 'pink' | 'teal';

export const READ_ALONG_STYLE_KEY = 'reader.readAlong.style';
export const READ_ALONG_COLOUR_KEY = 'reader.readAlong.colour';
export const READ_ALONG_STRENGTH_KEY = 'reader.readAlong.strength';
export const READ_ALONG_WORD_STYLE_KEY = 'reader.readAlong.wordStyle';
export const READ_ALONG_WORD_STRENGTH_KEY = 'reader.readAlong.wordStrength';

export const READ_ALONG_DEFAULT_STYLE: ReadAlongStyle = 'fill';
export const READ_ALONG_DEFAULT_COLOUR: ReadAlongColour = 'yellow';
export const READ_ALONG_DEFAULT_STRENGTH = 30;
export const READ_ALONG_DEFAULT_WORD_STYLE: ReadAlongWordStyle = 'highlight';
export const READ_ALONG_DEFAULT_WORD_STRENGTH = 70;

/** Percent of the fill colour: 10 is barely there, 60 is a highlighter. */
export const READ_ALONG_STRENGTH_MIN = 10;
export const READ_ALONG_STRENGTH_MAX = 60;
export const READ_ALONG_STRENGTH_STEP = 5;

/** The word goes over the sentence's wash, so it needs more of the colour:
    30% is a quiet second layer, 100% is the same ink at full strength. */
export const READ_ALONG_WORD_STRENGTH_MIN = 30;
export const READ_ALONG_WORD_STRENGTH_MAX = 100;
export const READ_ALONG_WORD_STRENGTH_STEP = 5;

/**
 * How far above the sentence the word is always kept, in percentage points.
 * The two ranges overlap (a 30% word under a 60% sentence would be a second
 * wash the eye cannot separate), so the word is never painted closer than this
 * to the sentence it sits on.
 */
export const READ_ALONG_WORD_LEAD = 15;

export const READ_ALONG_COLOURS: readonly ReadAlongColour[] = [
  'yellow',
  'green',
  'blue',
  'pink',
  'teal',
];

/**
 * The tokens behind each colour. Teal has no highlight pair of its own — the
 * accent is the palette's one teal — so both of its variables are `--accent`.
 * Both the light and the dark theme define every token named here, so the mark
 * never falls back to an unpainted background.
 */
export const READ_ALONG_COLOUR_VARS: Record<ReadAlongColour, { fill: string; ink: string }> = {
  yellow: { fill: 'var(--hl-yellow)', ink: 'var(--hl-yellow-ink)' },
  green: { fill: 'var(--hl-green)', ink: 'var(--hl-green-ink)' },
  blue: { fill: 'var(--hl-blue)', ink: 'var(--hl-blue-ink)' },
  pink: { fill: 'var(--hl-pink)', ink: 'var(--hl-pink-ink)' },
  teal: { fill: 'var(--selection-bg)', ink: 'var(--accent)' },
};

/** Anything but the two known styles reads as the default, not as broken CSS. */
export function normalizeStyle(value: unknown): ReadAlongStyle {
  return value === 'underline' ? 'underline' : READ_ALONG_DEFAULT_STYLE;
}

export function normalizeColour(value: unknown): ReadAlongColour {
  return READ_ALONG_COLOURS.includes(value as ReadAlongColour)
    ? (value as ReadAlongColour)
    : READ_ALONG_DEFAULT_COLOUR;
}

function clampToStep(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  step: number,
): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const stepped = Math.round(numeric / step) * step;
  return Math.min(max, Math.max(min, stepped));
}

/** A stored strength, snapped to the slider's 5% steps and clamped to 10–60. */
export function clampStrength(value: unknown): number {
  return clampToStep(
    value,
    READ_ALONG_DEFAULT_STRENGTH,
    READ_ALONG_STRENGTH_MIN,
    READ_ALONG_STRENGTH_MAX,
    READ_ALONG_STRENGTH_STEP,
  );
}

/** A stored word strength, snapped to its 5% steps and clamped to 30–100. */
export function clampWordStrength(value: unknown): number {
  return clampToStep(
    value,
    READ_ALONG_DEFAULT_WORD_STRENGTH,
    READ_ALONG_WORD_STRENGTH_MIN,
    READ_ALONG_WORD_STRENGTH_MAX,
    READ_ALONG_WORD_STRENGTH_STEP,
  );
}

/** Anything but the two known word marks reads as the default highlight. */
export function normalizeWordStyle(value: unknown): ReadAlongWordStyle {
  return value === 'underline' ? 'underline' : READ_ALONG_DEFAULT_WORD_STYLE;
}

/**
 * The word's coverage in percent: the reader's own strength, but never closer
 * than `READ_ALONG_WORD_LEAD` to the sentence's, so the word stays a separate
 * band of colour instead of a second identical wash.
 */
export function readAlongWordAlpha(strength: number, wordStrength: number): number {
  return Math.max(clampWordStrength(wordStrength), clampStrength(strength) + READ_ALONG_WORD_LEAD);
}

export interface ReadAlongSettings {
  style: ReadAlongStyle;
  colour: ReadAlongColour;
  strength: number;
  wordStyle: ReadAlongWordStyle;
  wordStrength: number;
}

/** The five settings, normalised: a junk value in storage never reaches CSS. */
export function useReadAlong(): ReadAlongSettings {
  const style = useSetting<unknown>(READ_ALONG_STYLE_KEY, READ_ALONG_DEFAULT_STYLE);
  const colour = useSetting<unknown>(READ_ALONG_COLOUR_KEY, READ_ALONG_DEFAULT_COLOUR);
  const strength = useSetting<unknown>(READ_ALONG_STRENGTH_KEY, READ_ALONG_DEFAULT_STRENGTH);
  const wordStyle = useSetting<unknown>(READ_ALONG_WORD_STYLE_KEY, READ_ALONG_DEFAULT_WORD_STYLE);
  const wordStrength = useSetting<unknown>(
    READ_ALONG_WORD_STRENGTH_KEY,
    READ_ALONG_DEFAULT_WORD_STRENGTH,
  );
  return {
    style: normalizeStyle(style),
    colour: normalizeColour(colour),
    strength: clampStrength(strength),
    wordStyle: normalizeWordStyle(wordStyle),
    wordStrength: clampWordStrength(wordStrength),
  };
}

/** The custom properties reader.css reads; set on the reader page and the preview. */
export function readAlongStyle(
  colour: ReadAlongColour,
  strength: number,
  wordStrength: number = READ_ALONG_DEFAULT_WORD_STRENGTH,
): CSSProperties {
  const tokens = READ_ALONG_COLOUR_VARS[normalizeColour(colour)];
  return {
    '--ra-color': tokens.fill,
    '--ra-ink': tokens.ink,
    '--ra-alpha': String(clampStrength(strength)),
    '--ra-word-alpha': String(readAlongWordAlpha(strength, wordStrength)),
  } as CSSProperties;
}
