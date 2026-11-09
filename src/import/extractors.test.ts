import { describe, expect, it } from 'vitest';
import { parseHtmlDocument } from './html';
import { markdownBlocks, parseMarkdown, stripInline } from './md';
import { parseText } from './txt';

function htmlDocument(html: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html');
}

describe('parseText', () => {
  it('turns blank-line separated chunks into blocks of one chapter', () => {
    const doc = parseText('First paragraph. Still first.\n\nSecond paragraph.', 'Notes');

    expect(doc.title).toBe('Notes');
    expect(doc.format).toBe('txt');
    expect(doc.chapters).toHaveLength(1);
    expect(doc.chapters[0]?.id).toBe('ch-0');
    expect(doc.chapters[0]?.blocks.map((block) => block.id)).toEqual(['b-0-0', 'b-0-1']);
    expect(doc.chapters[0]?.blocks[0]?.sentences.map((sentence) => sentence.id)).toEqual(['0-0-0', '0-0-1']);
  });

  it('returns no chapters for empty text', () => {
    expect(parseText('   \n\n  ', 'Empty').chapters).toEqual([]);
  });
});

describe('parseMarkdown', () => {
  const md = [
    '# Chapter One',
    '',
    'First para with **bold** and a [link](https://example.com).',
    '',
    '## Section A',
    '',
    'Second para.',
    '',
    '- item one',
    '- item two',
    '',
    '| Drug | Dose |',
    '| --- | --- |',
    '| Aspirin | 75 mg |',
  ].join('\n');

  it('makes `#` a chapter and `##` a heading block', () => {
    const doc = parseMarkdown(md, 'Fallback title');

    expect(doc.title).toBe('Fallback title');
    expect(doc.chapters).toHaveLength(1);
    const blocks = doc.chapters[0]?.blocks ?? [];
    expect(blocks.map((block) => block.kind)).toEqual(['p', 'h', 'p', 'li', 'li', 'table']);
    expect(blocks[1]?.sentences[0]?.text).toBe('Section A');
    expect(blocks[5]?.sentences.map((sentence) => sentence.text).join(' ')).toBe('Drug, Dose. Aspirin, 75 mg');
  });

  it('strips inline markdown from body text', () => {
    expect(stripInline('**bold** and *italic* with `code` and [link](x)')).toBe(
      'bold and italic with code and link',
    );
  });

  it('falls back to the first heading when no title is given', () => {
    expect(parseMarkdown('# Real Title\n\nBody.', '').title).toBe('Real Title');
  });
});

describe('parseHtmlDocument', () => {
  it('walks headings, paragraphs, lists, tables and figures', () => {
    const doc = parseHtmlDocument(
      htmlDocument(`
        <h1>Pharmacology</h1>
        <p>Body text.</p>
        <h2>Section A</h2>
        <p>More text.</p>
        <ul><li>One item.</li><li>Two item.</li></ul>
        <table><tr><th>Drug</th><th>Dose</th></tr><tr><td>Aspirin</td><td>75 mg</td></tr></table>
        <figure><figcaption>Figure 1: binding curve.</figcaption></figure>
      `),
      { format: 'html' },
    );

    expect(doc.chapters.map((chapter) => chapter.title)).toEqual(['Pharmacology', 'Section A']);

    expect(doc.chapters[0]?.blocks.map((block) => block.kind)).toEqual(['p']);
    expect(doc.chapters[0]?.blocks[0]?.sentences[0]?.text).toBe('Body text.');

    const section = doc.chapters[1];
    expect(section?.blocks.map((block) => block.kind)).toEqual(['p', 'li', 'li', 'table', 'figure']);
    expect(section?.blocks[0]?.sentences[0]?.text).toBe('More text.');
    expect(section?.blocks[3]?.sentences.map((sentence) => sentence.text).join(' ')).toBe(
      'Drug, Dose. Aspirin, 75 mg',
    );
    expect(section?.blocks[4]?.sentences[0]?.text).toBe('Figure 1: binding curve.');
  });

  it('skips navigation, scripts and hidden elements', () => {
    const doc = parseHtmlDocument(
      htmlDocument('<nav><a href="/">Menu</a></nav><script>var x = 1;</script><p>Real text.</p><div hidden>Secret.</div>'),
      { format: 'html', title: 'Page' },
    );

    const sentences = doc.chapters.flatMap((chapter) =>
      chapter.blocks.flatMap((block) => block.sentences.map((sentence) => sentence.text)),
    );
    expect(sentences).toEqual(['Real text.']);
  });

  it('drops margin notes so they cannot splice into the sentence they label', () => {
    const doc = parseHtmlDocument(
      htmlDocument(
        '<div class="sidenote">Diet.</div><p>Beef tea is <span class="sidenote">Beef tea.</span>not the most nutritive article.</p><aside>See also the appendix.</aside><p>Milk is next.</p>',
      ),
      { format: 'html', title: 'Page' },
    );

    const sentences = doc.chapters.flatMap((chapter) =>
      chapter.blocks.flatMap((block) => block.sentences.map((sentence) => sentence.text)),
    );
    expect(sentences).toEqual(['Beef tea is not the most nutritive article.', 'Milk is next.']);
  });

  it('prefers the given title, then <title>, then the first heading', () => {
    const withTitle = new DOMParser().parseFromString(
      '<html><head><title>From Title Tag</title></head><body><h1>Heading</h1><p>Body.</p></body></html>',
      'text/html',
    );
    expect(parseHtmlDocument(withTitle, { format: 'html' }).title).toBe('From Title Tag');
    expect(parseHtmlDocument(withTitle, { format: 'html', title: 'Explicit' }).title).toBe('Explicit');
  });

  it('keeps one chapter for an article without headings', () => {
    const doc = parseHtmlDocument(htmlDocument('<p>Alpha beta.</p><p>Gamma delta.</p>'), {
      format: 'html',
      title: 'Article',
    });

    expect(doc.chapters).toHaveLength(1);
    expect(doc.chapters[0]?.title).toBe('Article');
    expect(doc.chapters[0]?.blocks).toHaveLength(2);
  });
});

describe('markdownBlocks', () => {
  it('keeps list items separate from surrounding paragraphs', () => {
    const seeds = markdownBlocks('Intro line\n\n- first\n- second\n\nOutro line');

    expect(seeds.map((seed) => seed.kind)).toEqual(['p', 'li', 'li', 'p']);
  });
});
