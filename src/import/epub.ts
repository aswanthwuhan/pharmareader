import ePub from 'epubjs';
import type { NavItem } from 'epubjs';
import type { Chapter, ParsedDoc } from '../core/types';
import { normaliseText, type BlockSeed } from './blocks';
import { blocksFromRoot, chapterFromSpine } from './html';

/** The bits of an epubjs Section this module uses (the package has no exported type). */
interface SpineSection {
  href: string;
  unload?: () => void;
}

/**
 * Each spine item becomes a chapter, titled from the navigation document when it
 * lists that file. Per-sentence CFIs are not recorded: the walker drops element
 * references, so a page anchor could only point at the whole spine item.
 */
export async function parseEpub(data: ArrayBuffer, fallbackTitle: string): Promise<ParsedDoc> {
  const book = ePub();
  // epubjs 0.3.93's ESM entry (the one bundlers pick) only builds the Book; its
  // UMD bundle is the one that opens by itself. Without this `book.ready` never
  // settles and an EPUB import would sit there forever.
  await book.open(data, 'binary');
  await book.ready;

  try {
    const meta = await book.loaded.metadata;
    const title = normaliseText(meta.title) || normaliseText(fallbackTitle) || 'Untitled EPUB';
    const author = normaliseText(meta.creator) || undefined;
    const navigation = await book.loaded.navigation.catch(() => null);
    const tocTitles = titlesByHref(navigation?.toc ?? []);

    const sections: SpineSection[] = [];
    book.spine.each((section: SpineSection) => {
      sections.push(section);
    });

    const chapters: Chapter[] = [];
    // A Gutenberg EPUB splits its body into files by size, not at chapter breaks:
    // a file can open in the middle of one chapter and then hold two headings.
    // Collect every spine document first and split the book at its headings, so a
    // file's opening text stays with the chapter it belongs to instead of becoming
    // a chapter of its own that repeats the next chapter's title.
    const spineSeeds: BlockSeed[][] = [];
    const spineLabels: string[] = [];
    for (const section of sections) {
      const href = section.href;
      if (!href) continue;

      let chapterDoc: Document;
      try {
        chapterDoc = (await book.load(href)) as Document;
      } catch {
        continue;
      }
      if (!chapterDoc?.body) continue;

      spineSeeds.push(blocksFromRoot(chapterDoc.body));
      spineLabels.push(tocTitles.get(baseHref(href)) ?? tocTitles.get(basename(href)) ?? '');
      section.unload?.();
    }

    const hasHeadings = spineSeeds.some((seeds) => seeds.some((seed) => seed.kind === 'h' && (seed.level ?? 0) <= 2));
    if (hasHeadings) {
      for (const part of splitAtHeadings(spineSeeds.flat(), title)) {
        const chapter = chapterFromSpine(part.title, part.seeds, chapters.length);
        if (chapter) chapters.push(chapter);
      }
    } else {
      // No usable headings in the text: one chapter per spine file, named by the TOC.
      for (const [index, seeds] of spineSeeds.entries()) {
        const label = spineLabels[index] || `Section ${chapters.length + 1}`;
        const chapter = chapterFromSpine(label, seeds, chapters.length);
        if (chapter) chapters.push(chapter);
      }
    }

    return { title, author, format: 'epub', chapters };
  } finally {
    book.destroy();
  }
}

/**
 * Split a book's blocks at its chapter headings. The text before the first one
 * (title page, preface) becomes a chapter of its own named after the book.
 */
function splitAtHeadings(seeds: BlockSeed[], label: string): { title: string; seeds: BlockSeed[] }[] {
  const parts: { title: string; seeds: BlockSeed[] }[] = [];
  let current: BlockSeed[] = [];
  let title = label;

  const flush = () => {
    if (current.length) parts.push({ title, seeds: current });
    current = [];
  };

  for (const seed of seeds) {
    const heading = seed.kind === 'h' && (seed.level ?? 0) <= 2;
    const hasBody = current.some((entry) => entry.kind !== 'h');
    if (heading && hasBody) {
      flush();
      title = normaliseText(seed.text) || label;
    }
    current.push(seed);
  }
  flush();

  return parts.length ? parts : [{ title: label, seeds }];
}

function titlesByHref(items: NavItem[]): Map<string, string> {
  const map = new Map<string, string>();
  const visit = (list: NavItem[]) => {
    for (const item of list) {
      const href = baseHref(item.href);
      const label = normaliseText(item.label);
      if (href && label) {
        if (!map.has(href)) map.set(href, label);
        const name = basename(href);
        if (name && !map.has(name)) map.set(name, label);
      }
      if (item.subitems?.length) visit(item.subitems);
    }
  };
  visit(items);
  return map;
}

function baseHref(href: string): string {
  return (href.split('#')[0] ?? '').replace(/^\.\//, '');
}

function basename(href: string): string {
  return baseHref(href).split('/').pop() ?? '';
}
