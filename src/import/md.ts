import type { ParsedDoc } from '../core/types';
import { buildChapters, normaliseText, type BlockSeed } from './blocks';

/** Markdown → block seeds. `#` headings become chapter titles, `##`–`######` stay blocks. */
export function markdownBlocks(text: string): BlockSeed[] {
  const lines = text.split(/\r?\n/);
  const seeds: BlockSeed[] = [];
  let para: string[] = [];
  let inFence = false;

  const flush = () => {
    const merged = normaliseText(para.join(' '));
    if (merged) seeds.push({ kind: 'p', text: merged });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^\s*(?:```|~~~)/.test(line)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      if (line.trim()) para.push(line.trim());
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      seeds.push({ kind: 'h', level: heading[1].length, text: stripInline(heading[2].replace(/\s+#+\s*$/, '')) });
      continue;
    }

    if (/^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) {
      flush();
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      const rows: string[] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const current = lines[i].trim();
        const isSeparator = /^\|?[\s:|-]+$/.test(current);
        const cells = current
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((cell) => stripInline(cell))
          .filter(Boolean);
        if (!isSeparator && cells.length) rows.push(cells.join(', '));
        i++;
      }
      i--; // the for-loop advances again
      if (rows.length) seeds.push({ kind: 'table', text: rows.join('. ') });
      continue;
    }

    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      seeds.push({ kind: 'li', text: stripInline(item[1]) });
      continue;
    }

    const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      seeds.push({ kind: 'p', text: stripInline(quote[1]) });
      continue;
    }

    para.push(line.trim());
  }

  flush();
  return seeds;
}

export function parseMarkdown(text: string, fallbackTitle: string): ParsedDoc {
  const seeds = markdownBlocks(text);
  const title = normaliseText(fallbackTitle) || seeds.find((seed) => seed.kind === 'h')?.text || 'Notes';

  return { title, format: 'md', chapters: buildChapters(seeds, title, 1) };
}

/** Strip the inline markdown that would otherwise be read out by TTS. */
export function stripInline(value: string): string {
  return normaliseText(
    value
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\*([^*\n]+)\*/g, '$1')
      .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/\\([\\`*_{}[\]()#+\-.!>])/g, '$1'),
  );
}
