import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, rmdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDocs } from './docs.js';
import { publicDocumentation } from './docs-pages.js';

const roots: string[] = [];
async function fixture(content: string) {
  const root = await mkdtemp(join(tmpdir(), 'sazuz-docs-'));
  roots.push(root);
  for (const page of publicDocumentation) {
    await mkdir(join(root, dirname(page.source)), { recursive: true });
    await writeFile(join(root, page.source), `# ${page.label}\n`);
  }
  await writeFile(join(root, 'README.md'), '# Development README\n');
  await writeFile(join(root, 'docs/index.md'), content);
  await writeFile(join(root, 'docs/install.md'), '# Install\n\n## Quiet & safe\n\nBounded work.\n');
  await writeFile(join(root, 'docs/site.css'), 'body{color:#123}');
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0))
    if (resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('sazuz-docs-'))
      await rm(root, { recursive: true, force: true });
});

describe('standalone documentation build', () => {
  it('rewrites local pages and headings, escapes HTML and produces a script-free site', async () => {
    const root = await fixture(
      '# Overview\n\n[Guide](install.md#quiet--safe)\n\n<script>alert(1)</script>\n',
    );
    expect(await buildDocs(root)).toMatchObject({
      pages: publicDocumentation.length,
      localLinks: 1,
      scripts: false,
    });
    const html = await readFile(join(root, 'dist/docs-site/index.html'), 'utf8');
    expect(html).toContain('href="install.html#quiet--safe"');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain('Connect services');
    await writeFile(join(root, 'dist/docs-site/stale.html'), 'obsolete');
    await buildDocs(root);
    await expect(readFile(join(root, 'dist/docs-site/stale.html'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('excludes private documents, reports, media and stale output from every public file', async () => {
    const root = await fixture('# Overview\n');
    const privatePaths = [
      'README.md',
      'sazuz-build-prompt.md',
      'docs/PLAN.md',
      'docs/PROGRESS.md',
      'docs/DECISIONS.md',
      'docs/security-review.md',
      'docs/demo.md',
      'docs/future-internal-note.md',
      'docs/phases/phase-11-report.md',
      'docs/phases/phase-11-evidence.json',
      'docs/phases/phase-10-comparison.html',
      'docs/phases/assets/recording.webm',
      'dist/docs-site/PLAN.html',
      'dist/docs-site/phases/stale-report.html',
    ];
    for (const path of privatePaths) {
      await mkdir(join(root, dirname(path)), { recursive: true });
      await writeFile(join(root, path), '# PRIVATE_DOC_CANARY\n');
    }
    await buildDocs(root);
    const output = join(root, 'dist/docs-site');
    const entries = await readdir(output, { recursive: true, withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile());
    expect(files).toHaveLength(publicDocumentation.length + 2);
    for (const file of files) {
      const content = await readFile(join(file.parentPath, file.name), 'utf8');
      expect(content).not.toContain('PRIVATE_DOC_CANARY');
      expect(content).not.toMatch(/PLAN\.html|PROGRESS\.html|DECISIONS\.html|phases\//);
    }
    for (const page of publicDocumentation)
      await expect(readFile(join(output, page.output), 'utf8')).resolves.toContain(
        '<!doctype html>',
      );
    await expect(readFile(join(root, 'docs/PLAN.md'), 'utf8')).resolves.toContain(
      'PRIVATE_DOC_CANARY',
    );
  });

  it.each([
    'install.md#missing',
    'absent.md',
    '../../outside.json',
    'https://user:password@example.test/',
  ])('rejects a broken, unsafe or credential-bearing link (%s)', async (href) => {
    const root = await fixture(`# Overview\n\n[Bad](${href})\n`);
    await expect(buildDocs(root)).rejects.toThrow();
  });

  it.each([
    'PLAN.md',
    '%50LAN.md',
    '../sazuz-build-prompt.md',
    '../README.md',
    'phases/phase-11-report.md',
    'phases/phase-11-evidence.json',
    'phases/phase-10-comparison.html',
    'phases/assets/private.png',
    'phases/assets/private.webm',
    'future-internal-note.md',
  ])('refuses a link to an existing unapproved file (%s)', async (href) => {
    const root = await fixture(`# Overview\n\n[Private](${href})\n`);
    const path = resolve(root, 'docs', decodeURIComponent(href));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '# PRIVATE_LINK_CANARY\n');
    await expect(buildDocs(root)).rejects.toThrow();
  });

  it('refuses media references to private evidence', async () => {
    const root = await fixture('# Overview\n\n![Private](phases/assets/private.png)\n');
    await mkdir(join(root, 'docs/phases/assets'), { recursive: true });
    await writeFile(join(root, 'docs/phases/assets/private.png'), 'PRIVATE_IMAGE_CANARY');
    await expect(buildDocs(root)).rejects.toThrow();
  });

  it('rejects a public directory replaced with a symlink to private files', async () => {
    const root = await fixture('# Overview\n');
    await rm(join(root, 'docs/releases/1.0.0.md'));
    await rmdir(join(root, 'docs/releases'));
    await mkdir(join(root, 'private'));
    await writeFile(join(root, 'private/1.0.0.md'), '# PRIVATE_SYMLINK_CANARY\n');
    await symlink(join(root, 'private'), join(root, 'docs/releases'), 'junction');
    await expect(buildDocs(root)).rejects.toThrow();
  });
});
