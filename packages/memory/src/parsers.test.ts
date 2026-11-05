import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { parseDocument, chunkText, htmlText } from './parsers.js';
import { contextBudget, reciprocalRankFusion } from './retrieval.js';

function pdfFixture() {
  const text = 'BT /F1 12 Tf 72 720 Td (The launch code is ORCHID.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ];
  let file = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(file.length);
    file += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = file.length;
  file += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(file);
}
describe('bounded non-executing document ingestion', () => {
  it('extracts PDF page text with the supported pdf.js loading lifecycle', async () => {
    expect(await parseDocument('pdf', pdfFixture())).toEqual([
      { locator: 'Page 1', text: 'The launch code is ORCHID.' },
    ]);
  });
  it('extracts DOCX text while excluding embedded resources and external relationships', async () => {
    const files = zipSync({
      '[Content_Types].xml': Buffer.from(
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
      'word/document.xml': Buffer.from(
        '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Orchid is the launch code.</w:t></w:r></w:p></w:body></w:document>',
      ),
      'word/media/ignore.txt': Buffer.from('Unrequested embedded content'),
    });
    expect((await parseDocument('docx', files))[0]?.text).toBe('Orchid is the launch code.');
    const bomb = zipSync({ 'word/document.xml': new Uint8Array(16_000_001) });
    await expect(parseDocument('docx', bomb)).rejects.toMatchObject({ code: 'SOURCE_INVALID' });
  });
  it('cleans HTML without running scripts or loading embedded links, and preserves Markdown', async () => {
    const html =
      '<h1>Orchid</h1><script>throw new Error("must not run")</script><iframe src="http://127.0.0.1">hidden</iframe><p>Launch &amp; release</p>';
    expect(htmlText(html)).toBe('Orchid\n\nLaunch & release');
    expect((await parseDocument('html', Buffer.from(html)))[0]?.text).not.toMatch(
      /script|hidden|127\.0\.0\.1/,
    );
    expect(
      (await parseDocument('md', Buffer.from('# Orchid\n\nRelease checklist.')))[0]?.text,
    ).toBe('# Orchid\n\nRelease checklist.');
  });
  it('rejects unreadable, oversized and empty sources', async () => {
    for (const [kind, bytes] of [
      ['pdf', Buffer.from('not a PDF')],
      ['docx', Buffer.from('not a ZIP')],
      ['md', Buffer.from([255])],
      ['md', new Uint8Array(8 * 1024 * 1024 + 1)],
      ['html', Buffer.from('<script>nothing</script>')],
    ] as const)
      await expect(parseDocument(kind, bytes)).rejects.toMatchObject({ code: 'SOURCE_INVALID' });
  });
  it('chunks Unicode within byte bounds with overlap and retains the final passage', () => {
    const text =
      Array.from({ length: 350 }, (_, index) => `Orchid launch ${index}. `).join('') +
      '你好'.repeat(700) +
      ' FINAL SENTENCE';
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk) <= 2400)).toBe(true);
    expect(chunks.at(-1)).toContain('FINAL SENTENCE');
    expect(chunks[1]?.slice(0, 360).includes(chunks[0]!.slice(-100))).toBe(true);
    expect(chunks.join('')).not.toContain('\ufffd');
  });
  it('fuses independent ranks and honors a serialized context budget', () => {
    expect(
      reciprocalRankFusion([
        ['one', 'both'],
        ['two', 'both'],
      ])[0],
    ).toBe('both');
    expect(contextBudget(['x'.repeat(900), 'short'], 100)).toEqual(['short']);
  });
});
