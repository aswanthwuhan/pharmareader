import type { Chapter, DocFormat, ParsedDoc } from '../core/types';
import { buildChapters, chapterFromSeeds, normaliseText, type BlockSeed } from './blocks';

/**
 * Shared HTML walker. Used for `.html` files, Readability articles, mammoth
 * DOCX output and EPUB spine documents, so all of them produce the same
 * block/sentence model.
 */

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'HEAD', 'TITLE', 'META', 'LINK', 'TEMPLATE',
  'NAV', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SVG',
]);

const TEXT_BLOCK_TAGS = new Set(['P', 'LI', 'BLOCKQUOTE', 'PRE', 'DT', 'DD', 'CAPTION']);

function headingLevel(tag: string): number {
  const match = /^H([1-6])$/.exec(tag);
  return match ? Number(match[1]) : 0;
}

function isBlockTag(tag: string): boolean {
  return headingLevel(tag) > 0 || TEXT_BLOCK_TAGS.has(tag) || tag === 'TABLE' || tag === 'FIGURE';
}

function isHidden(el: Element): boolean {
  return el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true';
}

/** Walk a DOM subtree and flatten it into ordered block seeds. */
export function blocksFromRoot(root: Element): BlockSeed[] {
  const seeds: BlockSeed[] = [];
  walk(root, seeds);
  return seeds;
}

function walk(el: Element, out: BlockSeed[]): void {
  for (const child of Array.from(el.children)) {
    if (SKIP_TAGS.has(child.tagName) || isHidden(child)) continue;

    const level = headingLevel(child.tagName);
    if (level > 0) {
      out.push({ kind: 'h', level, text: textOf(child) });
      continue;
    }
    if (child.tagName === 'TABLE') {
      out.push({ kind: 'table', text: tableText(child) });
      continue;
    }
    if (child.tagName === 'FIGURE') {
      out.push({ kind: 'figure', text: figureText(child) });
      continue;
    }
    if (TEXT_BLOCK_TAGS.has(child.tagName)) {
      out.push({ kind: child.tagName === 'LI' ? 'li' : 'p', text: textOf(child) });
      continue;
    }

    if (containsBlock(child)) {
      walk(child, out);
    } else {
      // A div/section that only holds inline content is a paragraph of its own.
      const text = textOf(child);
      if (text) out.push({ kind: 'p', text });
    }
  }
}

function containsBlock(el: Element): boolean {
  for (const child of Array.from(el.children)) {
    if (isBlockTag(child.tagName)) return true;
    if (containsBlock(child)) return true;
  }
  return false;
}

function textOf(el: Element): string {
  return normaliseText(el.textContent ?? '');
}

function tableText(table: Element): string {
  const rows = Array.from(table.querySelectorAll('tr'));
  if (!rows.length) return textOf(table);

  return rows
    .map((row) =>
      Array.from(row.querySelectorAll('th,td'))
        .map(textOf)
        .filter(Boolean)
        .join(', '),
    )
    .filter(Boolean)
    .join('. ');
}

function figureText(figure: Element): string {
  const caption = figure.querySelector('figcaption');
  const captionText = caption ? textOf(caption) : '';
  if (captionText) return captionText;

  const image = figure.querySelector('img[alt]');
  const alt = image?.getAttribute('alt') ?? '';
  return normaliseText(alt) || textOf(figure);
}

export interface HtmlParseMeta {
  format: DocFormat;
  title?: string;
  author?: string;
  /** Headings at or above this level start a chapter. Default 2 (h1/h2). */
  chapterLevel?: number;
}

export function parseHtmlDocument(doc: Document, meta: HtmlParseMeta): ParsedDoc {
  const root = doc.body ?? doc.documentElement;
  const seeds = root ? blocksFromRoot(root) : [];

  const title =
    normaliseText(meta.title ?? '') ||
    normaliseText(doc.title) ||
    seeds.find((seed) => seed.kind === 'h')?.text ||
    'Untitled';

  return {
    title,
    author: meta.author ? normaliseText(meta.author) || undefined : undefined,
    format: meta.format,
    chapters: buildChapters(seeds, title, meta.chapterLevel ?? 2),
  };
}

/**
 * One chapter from one EPUB spine document. The first heading is dropped when it
 * just repeats the chapter title taken from the TOC.
 */
export function chapterFromSpine(title: string, seeds: BlockSeed[], chapterIdx: number): Chapter | null {
  const first = seeds[0];
  const body =
    first?.kind === 'h' && normaliseText(first.text) === normaliseText(title) ? seeds.slice(1) : seeds;
  return chapterFromSeeds(title, chapterIdx, body);
}
