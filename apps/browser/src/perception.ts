import { createHash } from 'node:crypto';
import type { ElementHandle, Page } from 'playwright';
import { BrowserError, type BrowserObservation } from '@sazuz/core/browser';
import type { BrowserChallenge } from './types.js';
import { currentPage, remember, scrub, type BrowserSession } from './session.js';
import { captureSensitiveState } from './state.js';

const interactive =
  'a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[role="link"],[role="checkbox"],[role="combobox"],[contenteditable="true"]';
export function safeOrigin(page: Page) {
  try {
    const url = new URL(page.url());
    return url.protocol === 'https:' ? url.origin : '';
  } catch {
    return '';
  }
}
export async function elementData(element: ElementHandle) {
  return element.evaluate((node) => {
    const el = node as HTMLElement;
    const input =
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
        ? el
        : null;
    const role =
      el.getAttribute('role') ??
      (el.tagName === 'A'
        ? 'link'
        : el.tagName === 'BUTTON'
          ? 'button'
          : el.tagName === 'SELECT'
            ? 'combobox'
            : el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'checkbox'
              ? 'checkbox'
              : 'textbox');
    const label = input?.labels?.[0]?.textContent ?? '';
    const name =
      el.getAttribute('aria-label') ||
      label ||
      el.getAttribute('placeholder') ||
      el.textContent ||
      el.getAttribute('name') ||
      role;
    return {
      role,
      name: name.trim().slice(0, 1000),
      fingerprint: JSON.stringify([
        el.tagName,
        el.getAttribute('type'),
        el.getAttribute('name'),
        el.getAttribute('href'),
        name,
        el.isConnected,
      ]),
      connected: el.isConnected,
      type: el.getAttribute('type') ?? '',
    };
  });
}
async function signature(page: Page) {
  const text = await page.locator('body').ariaSnapshot({ timeout: 3000 });
  return {
    text: text.slice(0, 40000),
    hash: createHash('sha256').update(page.url()).update(text).digest('hex'),
  };
}
export async function challenge(page: Page): Promise<BrowserChallenge | null> {
  if (
    await page
      .locator('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],[class*="captcha"],[data-sitekey]')
      .count()
  )
    return 'captcha';
  if (
    await page
      .locator(
        'input[autocomplete="one-time-code"],input[name*="otp" i],input[name*="verification" i]',
      )
      .count()
  )
    return 'verification';
  if (await page.locator('input[type="password"],input[autocomplete="current-password"]').count())
    return 'login';
  const text = (await page.locator('body').innerText({ timeout: 3000 })).slice(0, 20000);
  if (/verify (?:that )?you are human|complete (?:the )?captcha/i.test(text)) return 'captcha';
  if (/two.factor|verification code|authenticator code/i.test(text)) return 'verification';
  if ((await page.locator('form').count()) && /\b(sign in|log in|login)\b/i.test(text))
    return 'login';
  return null;
}
export async function paymentPage(page: Page) {
  if (await page.locator('input[autocomplete^="cc-"]').count()) return true;
  return /\b(credit card|card number|pay now|checkout|place order|confirm purchase|transfer money|send money|payment details)\b/i.test(
    (await page.locator('body').innerText({ timeout: 3000 })).slice(0, 20000),
  );
}
export async function observation(
  session: BrowserSession,
  reason: string | null = null,
): Promise<BrowserObservation> {
  const page = currentPage(session);
  await captureSensitiveState(session);
  // Input values never enter the observation; collect them only into this session's redactor.
  for (const value of session.fields.values()) remember(session, value);
  const fields = await page.locator('input,textarea').evaluateAll((nodes) =>
    nodes
      .filter((node) => !['checkbox', 'radio'].includes((node as HTMLInputElement).type))
      .map((node) => (node as HTMLInputElement).value)
      .filter(Boolean)
      .slice(0, 100),
  );
  for (const value of fields) remember(session, value);
  session.challenge = await challenge(page);
  if (session.challenge) {
    session.control = 'human';
    session.sensitive = true;
    session.images.clear();
  }
  const snapshot = await signature(page);
  session.signature = snapshot.hash;
  session.revision++;
  for (const value of session.refs.values()) await value.element.dispose();
  session.refs.clear();
  const handles = await page.locator(interactive).elementHandles();
  const elements: BrowserObservation['elements'] = [];
  for (const [index, element] of handles.entries()) {
    if (index >= 100 || !(await element.isVisible())) {
      await element.dispose();
      continue;
    }
    const data = await elementData(element);
    const ref = `r${session.revision}e${elements.length + 1}`;
    session.refs.set(ref, { element, ...data });
    elements.push({ ref, role: data.role.slice(0, 50), name: scrub(session, data.name, 300) });
  }
  const tabs = [];
  for (const [id, tab] of session.pages)
    if (!tab.isClosed())
      tabs.push({
        id,
        title: scrub(session, await tab.title(), 300),
        origin: safeOrigin(tab),
        active: id === session.activeTab,
      });
  return {
    sessionId: session.launch.sessionId,
    revision: session.revision,
    status: session.control === 'human' ? 'human_required' : reason ? 'blocked' : 'ready',
    reason:
      session.control === 'human'
        ? 'Complete login, 2FA or CAPTCHA in the live browser, then explicitly hand back.'
        : reason,
    challenge: session.challenge,
    origin: safeOrigin(page),
    title: scrub(session, await page.title(), 500),
    text:
      session.control === 'human'
        ? 'Human control is active.'
        : scrub(session, snapshot.text, 10000),
    elements: session.control === 'human' ? [] : elements,
    tabs,
    sensitive: session.sensitive,
    screenshot: session.sensitive ? 'withheld' : 'available',
  };
}
export async function reference(session: BrowserSession, ref: string) {
  const saved = session.refs.get(ref);
  if (!saved) throw new BrowserError('BROWSER_CONFLICT');
  const page = currentPage(session);
  const snapshot = await signature(page);
  const current = await elementData(saved.element);
  if (
    snapshot.hash !== session.signature ||
    !current.connected ||
    current.fingerprint !== saved.fingerprint
  )
    throw new BrowserError('BROWSER_CONFLICT');
  return saved.element;
}
