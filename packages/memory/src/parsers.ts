import { parse, type DefaultTreeAdapterMap } from 'parse5';
import mammoth from 'mammoth';
import { unzipSync, zipSync } from 'fflate';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parsedDocumentSchema } from '@sazuz/core/knowledge';
import { MemoryError } from './errors.js';
import { safeKnowledgeText } from './store.js';

const maxBytes = 8 * 1024 * 1024;
export interface ParsedSegment {
  locator: string;
  text: string;
}
function clean(text: string) {
  return safeKnowledgeText(
    text
      .replaceAll('\0', '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
}
export function htmlText(html: string): string {
  const root = parse(html);
  function visit(node: DefaultTreeAdapterMap['node']): string {
    if (
      'tagName' in node &&
      ['script', 'style', 'noscript', 'svg', 'iframe', 'object', 'template'].includes(node.tagName)
    )
      return '';
    if ('value' in node) return node.value;
    if (!('childNodes' in node)) return '';
    const contents = node.childNodes.map(visit).join('');
    return 'tagName' in node && /^(p|div|section|article|h[1-6]|li|tr|br)$/.test(node.tagName)
      ? `\n${contents}\n`
      : contents;
  }
  return clean(visit(root));
}
export async function parseDocument(
  kind: 'pdf' | 'docx' | 'md' | 'html',
  bytes: Uint8Array,
): Promise<ParsedSegment[]> {
  if (!bytes.length || bytes.byteLength > maxBytes) throw new MemoryError('SOURCE_INVALID');
  try {
    let segments: ParsedSegment[];
    if (kind === 'pdf') {
      // pdf.js 6 removed the JavaScript font evaluator and its isEvalSupported option.
      // Text extraction never enables the separate scripting manager or external resource loading.
      const task = getDocument({
        data: Uint8Array.from(bytes),
        useSystemFonts: false,
        disableFontFace: true,
        useWorkerFetch: false,
        useWasm: false,
        verbosity: 0,
      });
      try {
        const document = await task.promise;
        if (document.numPages > 200) throw new MemoryError('SOURCE_INVALID');
        segments = [];
        let total = 0;
        for (let page = 1; page <= document.numPages; page++) {
          const text = clean(
            (await (await document.getPage(page)).getTextContent()).items
              .map((item) => ('str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : ''))
              .join(''),
          );
          total += text.length;
          if (total > 1_000_000) throw new MemoryError('SOURCE_INVALID');
          if (text) segments.push({ locator: `Page ${page}`, text });
        }
      } finally {
        await task.destroy();
      }
    } else if (kind === 'docx') {
      let expanded = 0;
      let entries = 0;
      // Discard images, macros and relationships to external resources before mammoth sees the archive.
      const files = unzipSync(bytes, {
        filter: (file) => {
          expanded += file.originalSize;
          entries++;
          if (expanded > 16_000_000 || entries > 1000) throw new MemoryError('SOURCE_INVALID');
          return ['word/document.xml', '[Content_Types].xml', '_rels/.rels'].includes(file.name);
        },
      });
      const xml = files['word/document.xml'];
      if (!xml || /<!DOCTYPE|<!ENTITY/i.test(new TextDecoder().decode(xml)))
        throw new MemoryError('SOURCE_INVALID');
      const result = await mammoth.extractRawText({ buffer: Buffer.from(zipSync(files)) });
      segments = [{ locator: 'Document text', text: clean(result.value) }];
    } else {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      segments = [
        {
          locator: kind === 'html' ? 'Page text' : 'Document text',
          text: kind === 'html' ? htmlText(text) : clean(text),
        },
      ];
    }
    if (segments.reduce((total, segment) => total + segment.text.length, 0) > 1_000_000)
      throw new MemoryError('SOURCE_INVALID');
    return parsedDocumentSchema.parse(segments);
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    throw new MemoryError('SOURCE_INVALID');
  }
}
/** Paragraph/sentence boundaries where possible, ~800 estimated tokens with 15% byte overlap. */
export function chunkText(text: string): string[] {
  const characters = Array.from(text);
  const result: string[] = [];
  let start = 0;
  while (start < characters.length) {
    let end = start,
      bytes = 0,
      boundary = -1;
    while (end < characters.length && bytes + Buffer.byteLength(characters[end]!, 'utf8') <= 2400) {
      bytes += Buffer.byteLength(characters[end]!, 'utf8');
      end++;
      if (bytes > 1200 && /[\n.!?]/.test(characters[end - 1]!)) boundary = end;
    }
    if (end < characters.length && boundary > start) end = boundary;
    const chunk = characters.slice(start, end).join('').trim();
    if (chunk) result.push(chunk);
    if (result.length > 1500) throw new MemoryError('SOURCE_INVALID');
    if (end >= characters.length) break;
    let overlap = end,
      overlapBytes = 0;
    while (overlap > start + 1 && overlapBytes < 360) {
      overlap--;
      overlapBytes += Buffer.byteLength(characters[overlap]!, 'utf8');
    }
    start = Math.max(start + 1, overlap);
  }
  return result;
}
