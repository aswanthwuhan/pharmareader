import mammoth from 'mammoth';
import type { ParsedDoc } from '../core/types';
import { parseHtmlDocument } from './html';

/** DOCX → mammoth HTML → the shared HTML walker (headings start chapters). */
export async function parseDocx(data: ArrayBuffer, fallbackTitle: string): Promise<ParsedDoc> {
  const result = await mammoth.convertToHtml({ arrayBuffer: data });
  const doc = new DOMParser().parseFromString(result.value, 'text/html');
  return parseHtmlDocument(doc, { format: 'docx', title: fallbackTitle });
}
