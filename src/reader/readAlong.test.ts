import { describe, expect, it } from 'vitest';
import {
  READ_ALONG_COLOURS,
  READ_ALONG_COLOUR_KEY,
  READ_ALONG_COLOUR_VARS,
  READ_ALONG_DEFAULT_COLOUR,
  READ_ALONG_DEFAULT_STRENGTH,
  READ_ALONG_DEFAULT_STYLE,
  READ_ALONG_DEFAULT_WORD_STRENGTH,
  READ_ALONG_DEFAULT_WORD_STYLE,
  READ_ALONG_STRENGTH_KEY,
  READ_ALONG_STRENGTH_MAX,
  READ_ALONG_STRENGTH_MIN,
  READ_ALONG_STRENGTH_STEP,
  READ_ALONG_STYLE_KEY,
  READ_ALONG_WORD_LEAD,
  READ_ALONG_WORD_STRENGTH_KEY,
  READ_ALONG_WORD_STRENGTH_MAX,
  READ_ALONG_WORD_STRENGTH_MIN,
  READ_ALONG_WORD_STRENGTH_STEP,
  READ_ALONG_WORD_STYLE_KEY,
  clampStrength,
  clampWordStrength,
  normalizeColour,
  normalizeStyle,
  normalizeWordStyle,
  readAlongStyle,
  readAlongWordAlpha,
} from './readAlong';

describe('read-along: defaults', () => {
  it('starts as a yellow fill at 30%', () => {
    expect(READ_ALONG_DEFAULT_STYLE).toBe('fill');
    expect(READ_ALONG_DEFAULT_COLOUR).toBe('yellow');
    expect(READ_ALONG_DEFAULT_STRENGTH).toBe(30);
  });

  it('marks the spoken word with a 70% highlight', () => {
    expect(READ_ALONG_DEFAULT_WORD_STYLE).toBe('highlight');
    expect(READ_ALONG_DEFAULT_WORD_STRENGTH).toBe(70);
  });

  it('offers 10–60% in 5% steps, so the default is on the slider', () => {
    expect(READ_ALONG_STRENGTH_MIN).toBe(10);
    expect(READ_ALONG_STRENGTH_MAX).toBe(60);
    expect(READ_ALONG_STRENGTH_STEP).toBe(5);
    expect((READ_ALONG_STRENGTH_MAX - READ_ALONG_STRENGTH_MIN) % READ_ALONG_STRENGTH_STEP).toBe(0);
    expect(READ_ALONG_DEFAULT_STRENGTH).toBeGreaterThanOrEqual(READ_ALONG_STRENGTH_MIN);
    expect(READ_ALONG_DEFAULT_STRENGTH).toBeLessThanOrEqual(READ_ALONG_STRENGTH_MAX);
  });

  it('offers 30–100% for the word in 5% steps, so its default is on the slider', () => {
    expect(READ_ALONG_WORD_STRENGTH_MIN).toBe(30);
    expect(READ_ALONG_WORD_STRENGTH_MAX).toBe(100);
    expect(READ_ALONG_WORD_STRENGTH_STEP).toBe(5);
    expect((READ_ALONG_WORD_STRENGTH_MAX - READ_ALONG_WORD_STRENGTH_MIN) % READ_ALONG_WORD_STRENGTH_STEP).toBe(0);
    expect(READ_ALONG_DEFAULT_WORD_STRENGTH).toBeGreaterThanOrEqual(READ_ALONG_WORD_STRENGTH_MIN);
    expect(READ_ALONG_DEFAULT_WORD_STRENGTH).toBeLessThanOrEqual(READ_ALONG_WORD_STRENGTH_MAX);
  });

  it('keeps its three settings under the reader namespace', () => {
    expect(READ_ALONG_STYLE_KEY).toBe('reader.readAlong.style');
    expect(READ_ALONG_COLOUR_KEY).toBe('reader.readAlong.colour');
    expect(READ_ALONG_STRENGTH_KEY).toBe('reader.readAlong.strength');
  });

  it('keeps the spoken word beside them in the same namespace', () => {
    expect(READ_ALONG_WORD_STYLE_KEY).toBe('reader.readAlong.wordStyle');
    expect(READ_ALONG_WORD_STRENGTH_KEY).toBe('reader.readAlong.wordStrength');
  });

  it('names the five colours and maps each to two theme tokens, never a hex value', () => {
    expect(READ_ALONG_COLOURS).toEqual(['yellow', 'green', 'blue', 'pink', 'teal']);
    for (const colour of READ_ALONG_COLOURS) {
      const tokens = READ_ALONG_COLOUR_VARS[colour];
      expect(tokens.fill).toMatch(/^var\(--[a-z-]+\)$/);
      expect(tokens.ink).toMatch(/^var\(--[a-z-]+\)$/);
    }
    // Teal is the palette's accent, since it has no highlight pair of its own.
    expect(READ_ALONG_COLOUR_VARS.teal).toEqual({ fill: 'var(--selection-bg)', ink: 'var(--accent)' });
  });
});

describe('read-along: stored values', () => {
  it('clamps the strength into 10–60 and snaps it to a 5% step', () => {
    expect(clampStrength(30)).toBe(30);
    expect(clampStrength(0)).toBe(10);
    expect(clampStrength(-20)).toBe(10);
    expect(clampStrength(100)).toBe(60);
    expect(clampStrength(60)).toBe(60);
    expect(clampStrength(63)).toBe(60);
    expect(clampStrength(37)).toBe(35);
    expect(clampStrength(12)).toBe(10);
    expect(clampStrength(13)).toBe(15);
  });

  it('reads a usable number out of the stored string', () => {
    expect(clampStrength('45')).toBe(45);
    expect(clampStrength('0')).toBe(10);
  });

  it('falls back to the default for anything that is not a number', () => {
    expect(clampStrength(Number.NaN)).toBe(30);
    expect(clampStrength(Number.POSITIVE_INFINITY)).toBe(30);
    expect(clampStrength(undefined)).toBe(30);
    expect(clampStrength('dense')).toBe(30);
    expect(clampStrength({})).toBe(30);
  });

  it('reads any unknown style as a fill and any unknown colour as yellow', () => {
    expect(normalizeStyle('underline')).toBe('underline');
    expect(normalizeStyle('fill')).toBe('fill');
    expect(normalizeStyle('outline')).toBe('fill');
    expect(normalizeStyle(undefined)).toBe('fill');

    expect(normalizeColour('blue')).toBe('blue');
    expect(normalizeColour('teal')).toBe('teal');
    expect(normalizeColour('purple')).toBe('yellow');
    expect(normalizeColour(null)).toBe('yellow');
  });

  it('puts the chosen tokens on the root as --ra-color, --ra-ink and --ra-alpha', () => {
    const blue = readAlongStyle('blue', 45) as Record<string, string>;
    expect(blue['--ra-color']).toBe('var(--hl-blue)');
    expect(blue['--ra-ink']).toBe('var(--hl-blue-ink)');
    expect(blue['--ra-alpha']).toBe('45');

    const clamped = readAlongStyle('yellow', 500) as Record<string, string>;
    expect(clamped['--ra-alpha']).toBe('60');
  });

  it('puts the word strength beside them as --ra-word-alpha', () => {
    expect((readAlongStyle('blue', 45, 85) as Record<string, string>)['--ra-word-alpha']).toBe('85');
    // The default word strength fills in when the caller names only the sentence.
    expect((readAlongStyle('blue', 45) as Record<string, string>)['--ra-word-alpha']).toBe('70');
    expect((readAlongStyle('yellow', 500, 500) as Record<string, string>)['--ra-word-alpha']).toBe('100');
  });
});

describe('read-along: the spoken word', () => {
  it('clamps the word strength into 30–100 and snaps it to a 5% step', () => {
    expect(clampWordStrength(70)).toBe(70);
    expect(clampWordStrength(0)).toBe(30);
    expect(clampWordStrength(-20)).toBe(30);
    expect(clampWordStrength(30)).toBe(30);
    expect(clampWordStrength(100)).toBe(100);
    expect(clampWordStrength(105)).toBe(100);
    expect(clampWordStrength(200)).toBe(100);
    expect(clampWordStrength(82)).toBe(80);
    expect(clampWordStrength(33)).toBe(35);
    expect(clampWordStrength('85')).toBe(85);
    expect(clampWordStrength(Number.NaN)).toBe(70);
    expect(clampWordStrength(undefined)).toBe(70);
  });

  it('reads any unknown word mark as the highlight', () => {
    expect(normalizeWordStyle('highlight')).toBe('highlight');
    expect(normalizeWordStyle('underline')).toBe('underline');
    expect(normalizeWordStyle('dashed')).toBe('highlight');
    expect(normalizeWordStyle(undefined)).toBe('highlight');
  });

  it('keeps the word at least the lead above the sentence, at every pairing', () => {
    for (let sentence = READ_ALONG_STRENGTH_MIN; sentence <= READ_ALONG_STRENGTH_MAX; sentence += 5) {
      for (let word = READ_ALONG_WORD_STRENGTH_MIN; word <= READ_ALONG_WORD_STRENGTH_MAX; word += 5) {
        const alpha = readAlongWordAlpha(sentence, word);
        expect(alpha).toBeGreaterThan(sentence);
        expect(alpha).toBeGreaterThanOrEqual(word);
        expect(alpha).toBeLessThanOrEqual(100);
      }
    }
    // The reader's own value wins unless it would sit under the sentence's.
    expect(readAlongWordAlpha(30, 70)).toBe(70);
    expect(readAlongWordAlpha(60, 30)).toBe(60 + READ_ALONG_WORD_LEAD);
    expect(readAlongWordAlpha(10, 100)).toBe(100);
    // A junk sentence strength still lands on the sentence's own clamp first.
    expect(readAlongWordAlpha(500, 30)).toBe(75);
  });
});
