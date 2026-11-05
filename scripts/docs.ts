import { mkdir, readFile, realpath, lstat, rm, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join, sep, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import MarkdownIt from 'markdown-it';
import type { Token } from 'markdown-it';
import { documentationGroups, publicDocumentation } from './docs-pages.js';

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\-_ ]/gu, '')
    .replaceAll(' ', '-');
const walkTokens = function* (tokens: Token[]): Generator<Token> {
  for (const token of tokens) {
    yield token;
    if (token.children) yield* walkTokens(token.children);
  }
};
type Page = {
  source: string;
  output: string;
  title: string;
  tokens: Token[];
  headings: Set<string>;
};

/** Publish only named public guides; never discover documents or copy linked evidence. */
export async function buildDocs(inputRoot = process.cwd()) {
  const root = await realpath(inputRoot);
  const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
  const escape = markdown.utils.escapeHtml;
  async function safeFile(source: string) {
    if (
      source.startsWith('../') ||
      posix.isAbsolute(source) ||
      source.includes('\\') ||
      source.includes(':')
    )
      throw new Error(`Unsafe documentation path: ${source}`);
    const path = await realpath(resolve(root, source));
    if (
      !path.startsWith(root + sep) ||
      path !== resolve(root, source) ||
      !(await lstat(path)).isFile()
    )
      throw new Error(`Documentation file is outside its approved source path: ${source}`);
    return path;
  }
  const pages = new Map<string, Page>();
  for (const { source, output } of publicDocumentation) {
    const tokens = markdown.parse(await readFile(await safeFile(source), 'utf8'), {});
    const headings = new Set<string>();
    let title = '';
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (token.type !== 'heading_open') continue;
      const text = [...walkTokens(tokens[index + 1]?.children ?? [])]
        .filter((child) => ['text', 'code_inline'].includes(child.type))
        .map((child) => child.content)
        .join('');
      if (!title) title = text;
      const base = slug(text);
      let id = base,
        suffix = 0;
      while (headings.has(id)) id = `${base}-${++suffix}`;
      headings.add(id);
      token.attrSet('id', id);
    }
    if (!title) throw new Error(`Documentation needs a heading: ${source}`);
    pages.set(source, { source, output, title, tokens, headings });
  }
  if (!pages.has('docs/index.md')) throw new Error('The documentation overview is missing.');
  let links = 0;
  for (const page of pages.values())
    for (const token of walkTokens(page.tokens)) {
      const attribute = token.type === 'link_open' ? 'href' : token.type === 'image' ? 'src' : null;
      if (!attribute) continue;
      const href = token.attrGet(attribute);
      if (!href) continue;
      if (typeof href !== 'string')
        throw new Error(`Invalid documentation link in ${page.source}.`);
      if (/^https?:\/\//.test(href)) {
        const url = new URL(href);
        if (url.username || url.password)
          throw new Error(`Credential-bearing documentation link: ${page.source}`);
        token.attrSet('rel', 'noreferrer noopener');
        continue;
      }
      if (/^[a-zA-Z][\w+.-]*:/.test(href) || href.startsWith('//') || href.includes('?'))
        throw new Error(`Unsupported documentation link in ${page.source}: ${href}`);
      const [path = '', fragment] = href.split('#');
      const source = path
        ? posix.normalize(posix.join(posix.dirname(page.source), decodeURIComponent(path)))
        : page.source;
      const target = pages.get(source);
      if (!target || token.type === 'image')
        throw new Error(`Unapproved public documentation link in ${page.source}: ${href}`);
      if (fragment && !target.headings.has(decodeURIComponent(fragment)))
        throw new Error(`Missing documentation heading in ${page.source}: ${href}`);
      const output = target.output;
      links++;
      token.attrSet(
        attribute,
        (posix.relative(posix.dirname(page.output), output) || posix.basename(output)) +
          (fragment ? `#${fragment}` : ''),
      );
    }
  const output = resolve(root, 'dist/docs-site');
  // This is the single generated output directory. Never follow a replaced dist
  // or output symlink when cleaning an earlier build.
  await mkdir(join(root, 'dist'), { recursive: true });
  if ((await realpath(join(root, 'dist'))) !== join(root, 'dist'))
    throw new Error('Unsafe docs output directory.');
  try {
    if ((await realpath(output)) !== output || !output.startsWith(root + sep))
      throw new Error('Unsafe docs output directory.');
    await rm(output, { recursive: true, force: true });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  await mkdir(output, { recursive: true });
  await copyFile(await safeFile('docs/site.css'), join(output, 'site.css'));
  for (const page of pages.values()) {
    const relative = (target: string) =>
      posix.relative(posix.dirname(page.output), target) || posix.basename(target);
    const nav = documentationGroups
      .map((group) => {
        const links = group.pages
          .map(
            ([source, label]) =>
              `<li><a href="${escape(relative(pages.get(source)!.output))}"${source === page.source ? ' aria-current="page"' : ''}>${escape(label)}</a></li>`,
          )
          .join('');
        return `<details open><summary>${escape(group.title)}</summary><nav aria-label="${escape(group.title)}"><ul>${links}</ul></nav></details>`;
      })
      .join('');
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; img-src 'self'; media-src 'self'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>${escape(page.title)} · Sazuz</title><link rel="stylesheet" href="${escape(relative('site.css'))}"></head><body><a class="skip" href="#content">Skip to content</a><header><a class="brand" href="${escape(relative('index.html'))}">Sazuz<span>Documentation</span></a><a href="${escape(relative('install.html'))}">Install Sazuz</a></header><div class="layout"><aside>${nav}</aside><main id="content" tabindex="-1"><article>${markdown.renderer.render(page.tokens, markdown.options, {})}</article><footer>Sazuz user documentation · See <a href="${escape(relative('releases.html'))}">release verification</a> for deployment checks.</footer></main></div></body></html>`;
    await mkdir(join(output, posix.dirname(page.output)), { recursive: true });
    await writeFile(join(output, page.output), html);
  }
  const report = {
    pages: pages.size,
    localLinks: links,
    assets: 0,
    scripts: false,
    output: 'dist/docs-site',
  };
  await writeFile(join(output, 'site-manifest.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(JSON.stringify(await buildDocs()) + '\n');
  } catch (error) {
    process.stderr.write(
      (error instanceof Error ? error.message : 'Documentation build failed.') + '\n',
    );
    process.exitCode = 1;
  }
}
