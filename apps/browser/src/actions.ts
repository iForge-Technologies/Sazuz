import { createHash, randomBytes } from 'node:crypto';
import {
  BrowserError,
  browserFileSchema,
  type BrowserCommand,
  type BrowserObservation,
} from '@sazuz/core/browser';
import { workKey } from '@sazuz/db';
import { currentPage, remember, scrub, type BrowserSession } from './session.js';
import { challenge, elementData, observation, paymentPage, reference } from './perception.js';
import { captureSensitiveState } from './state.js';
import { resolveTarget } from './resolve.js';

export function scanText(name: string, content: Buffer) {
  if (content.length > 262144 || !/\.(?:txt|csv|json)$/i.test(name) || content.includes(0))
    throw new BrowserError('BROWSER_DENIED');
  const text = content.toString('utf8');
  if (
    !Buffer.from(text).equals(content) ||
    [...text].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 && ![9, 10, 13].includes(code);
    }) ||
    /EICAR-STANDARD-ANTIVIRUS-TEST-FILE|<\s*(?:script|iframe|html|svg)|^#!|(?:^|[,;\r\n])\s*"?(?:[=+@]|-\s*[a-z])/im.test(
      text,
    )
  )
    throw new BrowserError('BROWSER_DENIED');
  if (/\.json$/i.test(name)) {
    try {
      JSON.parse(text);
    } catch {
      throw new BrowserError('BROWSER_DENIED');
    }
  }
  return text;
}
export async function perform(
  session: BrowserSession,
  command: BrowserCommand,
  secret?: string,
): Promise<BrowserObservation> {
  const page = currentPage(session);
  await captureSensitiveState(session);
  const { operation, args } = command;
  if (await challenge(page)) session.control = 'human';
  if (session.control === 'human')
    return { ...(await observation(session)), actionPerformed: false };
  // A later action invalidates a screenshot that has not yet reached its model turn.
  session.images.clear();
  if (
    ['click', 'type', 'select', 'upload', 'download'].includes(operation) &&
    (await paymentPage(page))
  )
    return observation(session, 'Automated payment actions are denied.');
  let extracted: BrowserObservation['extracted'];
  let file: BrowserObservation['file'];
  let imageHandle: string | undefined;
  switch (operation) {
    case 'resolve':
      return resolveTarget(session, args.target);
    case 'open':
    case 'read':
      break;
    case 'navigate':
      if (new URL(args.url).origin !== session.launch.site)
        throw new BrowserError('BROWSER_DENIED');
      await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 10000 });
      break;
    case 'click':
      await (await reference(session, args.ref)).click({ timeout: 5000 });
      break;
    case 'type': {
      const element = await reference(session, args.ref);
      const data = await elementData(element);
      if (data.type === 'password')
        return observation(session, 'Login fields require human control.');
      const value = 'secret' in args.value ? secret : args.value.text;
      if (value === undefined || new URL(page.url()).origin !== session.launch.site)
        throw new BrowserError('BROWSER_DENIED');
      if ('secret' in args.value) {
        session.sensitive = true;
        remember(session, value);
      }
      await element.fill(value, { timeout: 5000 });
      break;
    }
    case 'select':
      await (await reference(session, args.ref)).selectOption(args.values, { timeout: 5000 });
      break;
    case 'scroll':
      await page.mouse.wheel(0, args.pixels * (args.direction === 'up' ? -1 : 1));
      break;
    case 'wait_for':
      await page
        .getByText(args.text, { exact: false })
        .first()
        .waitFor({ state: 'visible', timeout: args.timeoutMs });
      break;
    case 'extract': {
      extracted = {};
      for (const [name, spec] of Object.entries(args.schema.properties)) {
        const value = scrub(
          session,
          spec.source === 'title'
            ? await page.title()
            : spec.source === 'text'
              ? await page.locator('body').innerText()
              : await (await reference(session, spec.ref!)).innerText(),
          4000,
        );
        extracted[name] =
          spec.type === 'string'
            ? value
            : spec.type === 'number' && value.trim() && Number.isFinite(Number(value))
              ? Number(value)
              : spec.type === 'boolean' && /^(true|false)$/i.test(value.trim())
                ? value.trim().toLowerCase() === 'true'
                : null;
      }
      break;
    }
    case 'screenshot':
      if (!session.sensitive) {
        imageHandle = `bim_${randomBytes(16).toString('hex')}`;
        const data = (await page.screenshot({ type: 'jpeg', quality: 60, timeout: 5000 })).toString(
          'base64',
        );
        session.images.clear();
        if (data.length > 2000000) throw new BrowserError('BROWSER_DENIED');
        session.images.set(imageHandle, { data, expiresAt: Date.now() + 30000 });
      }
      break;
    case 'download': {
      if (session.sensitive || session.files.size >= 16) throw new BrowserError('BROWSER_DENIED');
      const element = await reference(session, args.ref);
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 5000 }),
        element.click({ timeout: 5000 }),
      ]);
      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const part of stream) {
          const bytes = Buffer.isBuffer(part) ? part : Buffer.from(String(part));
          size += bytes.length;
          if (size > 262144) {
            await download.cancel();
            throw new BrowserError('BROWSER_DENIED');
          }
          chunks.push(bytes);
        }
      } finally {
        stream.destroy();
        await download.delete();
      }
      const original = download.suggestedFilename();
      const text = scanText(original, Buffer.concat(chunks));
      const content = Buffer.from(scrub(session, text, 262144));
      const handle = workKey('bfl');
      const extension = original.toLowerCase().endsWith('.json')
        ? 'json'
        : original.toLowerCase().endsWith('.csv')
          ? 'csv'
          : 'txt';
      const name = `download.${extension}`;
      const sha256 = createHash('sha256').update(content).digest('hex');
      session.files.set(handle, { name, content, sha256 });
      file = browserFileSchema.parse({
        handle,
        name,
        bytes: content.length,
        sha256,
        scan: 'restricted-text',
      });
      break;
    }
    case 'upload': {
      const value = session.files.get(args.fileHandle);
      if (!value) throw new BrowserError('BROWSER_DENIED');
      await (
        await reference(session, args.ref)
      ).setInputFiles(
        { name: value.name, mimeType: 'text/plain', buffer: value.content },
        { timeout: 5000 },
      );
      break;
    }
    case 'tabs': {
      if (args.action === 'new') {
        if (session.pages.size >= 4) throw new BrowserError('BROWSER_DENIED');
        const tab = await session.context.newPage();
        session.activeTab = [...session.pages].find(([, value]) => value === tab)![0];
      } else if (args.action !== 'list') {
        const tab = args.tabId ? session.pages.get(args.tabId) : undefined;
        if (!tab) throw new BrowserError('BROWSER_DENIED');
        if (args.action === 'switch') session.activeTab = args.tabId!;
        else {
          if (session.pages.size === 1) throw new BrowserError('BROWSER_DENIED');
          await tab.close();
          session.pages.delete(args.tabId!);
          if (session.activeTab === args.tabId)
            session.activeTab = session.pages.keys().next().value!;
        }
      }
      break;
    }
    case 'close':
      break;
  }
  const result = await observation(session);
  return {
    ...result,
    actionPerformed: true,
    ...(extracted ? { extracted } : {}),
    ...(file ? { file } : {}),
    ...(imageHandle ? { imageHandle } : {}),
    ...(operation === 'close' ? { status: 'closed' as const, reason: null } : {}),
  };
}
