import mammoth from 'mammoth';
import type { ParsedDoc } from '../core/types';
import { parseHtmlDocument } from './html';

/** DOCX → mammoth HTML → the shared HTML walker (headings start chapters). */
export async function parseDocx(data: ArrayBuffer, fallbackTitle: string): Promise<ParsedDoc> {
  // The browser build of mammoth reads `arrayBuffer`; its Node build reads `buffer`
  // and throws "Could not find file in options" otherwise (tests run in Node).
  const input =
    typeof Buffer === 'undefined'
      ? { arrayBuffer: data }
      : { arrayBuffer: data, buffer: Buffer.from(data) };
  const result = await mammoth.convertToHtml(input as Parameters<typeof mammoth.convertToHtml>[0]);
  const doc = new DOMParser().parseFromString(result.value, 'text/html');
  return parseHtmlDocument(doc, { format: 'docx', title: fallbackTitle });
}
