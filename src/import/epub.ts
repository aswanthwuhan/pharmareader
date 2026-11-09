import ePub from 'epubjs';
import type { NavItem } from 'epubjs';
import type { Chapter, ParsedDoc } from '../core/types';
import { normaliseText } from './blocks';
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
  const book = ePub(data);
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

      const seeds = blocksFromRoot(chapterDoc.body);
      const label =
        tocTitles.get(baseHref(href)) ?? tocTitles.get(basename(href)) ?? `Section ${chapters.length + 1}`;
      const chapter = chapterFromSpine(label, seeds, chapters.length);
      if (chapter) chapters.push(chapter);
      section.unload?.();
    }

    return { title, author, format: 'epub', chapters };
  } finally {
    book.destroy();
  }
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
