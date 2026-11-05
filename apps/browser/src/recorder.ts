import { and, eq } from 'drizzle-orm';
import type { ElementHandle } from 'playwright';
import { browserRecordings, type Database } from '@sazuz/db';
import {
  elementFingerprintSchema,
  recordingEventsSchema,
  type ElementFingerprint,
  type RecordingEvent,
} from '@sazuz/core/learning';
import type { BrowserHumanInput } from '@sazuz/core/browser';
import { BrowserError } from '@sazuz/core/browser';
import { currentPage, remember, scrub, type BrowserSession } from './session.js';
import { challenge, elementData, paymentPage } from './perception.js';
import { captureSensitiveState } from './state.js';

/** Selectors are data. No page-defined binding can submit a trusted recorder event. */
export async function fingerprint(
  session: BrowserSession,
  element: ElementHandle,
): Promise<ElementFingerprint | null> {
  const data = await elementData(element);
  if (!['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio'].includes(data.role))
    return null;
  const attrs = await element.evaluate((node) => {
    const el = node as HTMLElement;
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id,
      testId: el.getAttribute('data-testid'),
      name: el.getAttribute('name'),
      type: el.getAttribute('type'),
      autocomplete: el.getAttribute('autocomplete'),
      text:
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
          ? ''
          : (el.textContent ?? '').trim().slice(0, 300),
    };
  });
  if (
    /password|hidden|file/i.test(attrs.type ?? '') ||
    /password|one-time-code|cc-|username/i.test(attrs.autocomplete ?? '') ||
    /password|passcode|token|secret|otp|verification|api.?key|access.?code/i.test(attrs.name ?? '')
  )
    return null;
  const name = scrub(session, data.name, 300),
    text = scrub(session, attrs.text, 300);
  const locators: ElementFingerprint['locators'] = [];
  const safeAttribute = (value: string | null) =>
    value && /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(value) && scrub(session, value, 100) === value;
  if (safeAttribute(attrs.testId)) locators.push({ kind: 'testId', value: attrs.testId! });
  if (safeAttribute(attrs.id)) locators.push({ kind: 'css', value: `[id="${attrs.id}"]` });
  const role = elementFingerprintSchema.shape.role.parse(data.role);
  if (name && !name.includes('[REDACTED]') && !name.includes('[Sensitive')) {
    locators.push({ kind: 'role', role, name });
    if (['textbox', 'combobox', 'checkbox', 'radio'].includes(role))
      locators.push({ kind: 'label', value: name });
  }
  if (safeAttribute(attrs.name)) {
    locators.push({ kind: 'css', value: `${attrs.tag}[name="${attrs.name}"]` });
    locators.push({ kind: 'xpath', value: `//${attrs.tag}[@name="${attrs.name}"]` });
  }
  if (!locators.length) return null;
  return elementFingerprintSchema.parse({
    role,
    name,
    text,
    locators: locators.slice(0, 6),
    box: await element.boundingBox(),
    crop: 'withheld',
  });
}
async function inputTarget(session: BrowserSession, input: BrowserHumanInput) {
  const page = currentPage(session);
  const handle = await page.evaluateHandle(
    ({ pointer, x, y }) => {
      const selected = pointer ? document.elementFromPoint(x, y) : document.activeElement;
      return (
        selected?.closest(
          'button,a[href],input,textarea,select,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[contenteditable="true"]',
        ) ?? null
      );
    },
    {
      pointer: input.type === 'pointer',
      x: input.type === 'pointer' ? input.x : 0,
      y: input.type === 'pointer' ? input.y : 0,
    },
  );
  const element = handle.asElement();
  if (!element) await handle.dispose();
  return element;
}
function safeUrl(session: BrowserSession): string | null {
  try {
    const url = new URL(currentPage(session).url());
    if (url.origin !== session.launch.site || url.username || url.password) return null;
    const clean = url.origin + url.pathname;
    return scrub(session, clean, 4096) === clean ? clean : null;
  } catch {
    return null;
  }
}
export function createRecorder(database: Database) {
  async function append(
    session: BrowserSession,
    event: Omit<RecordingEvent, 'id'> | null,
    omitted = false,
  ) {
    await database.orm.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(browserRecordings)
        .where(
          and(
            eq(browserRecordings.sessionId, session.launch.sessionId),
            eq(browserRecordings.status, 'recording'),
          ),
        )
        .for('update');
      if (!row) return;
      const events = recordingEventsSchema.parse(row.events);
      if (event) {
        const previous = events.findLast((item) => item.replay);
        const same =
          previous?.kind === event.kind &&
          JSON.stringify(previous.target?.locators) === JSON.stringify(event.target?.locators);
        if (
          !(same && (event.kind === 'fill' || event.kind === 'select')) &&
          !(event.kind === 'navigate' && events.at(-1)?.url === event.url)
        )
          events.push({
            ...event,
            id: `e${Math.max(0, ...events.map((item) => Number(item.id.slice(1)))) + 1}`,
          });
      }
      // Redact page data, never protocol enums/IDs (a short field value may be "on").
      const clean = events.flatMap((item) => {
        if (item.url && scrub(session, item.url, 4096) !== item.url) return [];
        if (!item.target) return [item];
        const locators = item.target.locators.filter((locator) => {
          const value = locator.kind === 'role' ? locator.name : locator.value;
          return scrub(session, value, 500) === value;
        });
        if (!locators.length) return [];
        return [
          {
            ...item,
            target: {
              ...item.target,
              name: scrub(session, item.target.name, 300),
              text: scrub(session, item.target.text, 300),
              locators,
            },
          },
        ];
      });
      const parsed = recordingEventsSchema.safeParse(clean);
      if (!parsed.success) {
        await tx
          .update(browserRecordings)
          .set({
            status: 'interrupted',
            omitted: row.omitted + 1,
            version: row.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(browserRecordings.id, row.id));
        return;
      }
      await tx
        .update(browserRecordings)
        .set({
          events: parsed.data,
          omitted: row.omitted + (omitted ? 1 : 0) + events.length - clean.length,
          version: row.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(browserRecordings.id, row.id));
    });
  }
  async function active(session: BrowserSession) {
    return (
      (
        await database.orm
          .select({ id: browserRecordings.id })
          .from(browserRecordings)
          .where(
            and(
              eq(browserRecordings.sessionId, session.launch.sessionId),
              eq(browserRecordings.status, 'recording'),
            ),
          )
          .limit(1)
      ).length > 0
    );
  }
  async function initial(session: BrowserSession) {
    if (session.control !== 'human') throw new BrowserError('BROWSER_DENIED');
    await captureSensitiveState(session);
    const url = safeUrl(session);
    if (
      url &&
      !(await challenge(currentPage(session))) &&
      !(await paymentPage(currentPage(session)))
    )
      await append(session, { kind: 'navigate', target: null, url, replay: true });
    else await append(session, null, true);
  }
  async function beforeInput(session: BrowserSession, input: BrowserHumanInput) {
    if (!(await active(session))) return;
    if (input.type === 'pointer' && input.event !== 'mousePressed') return;
    if (input.type === 'key' && input.event !== 'keyDown') return;
    await captureSensitiveState(session);
    for (const value of session.fields.values()) remember(session, value);
    const page = currentPage(session);
    const values = await page.locator('input,textarea').evaluateAll((nodes) =>
      nodes
        .filter((node) => !['checkbox', 'radio'].includes((node as HTMLInputElement).type))
        .map((node) => (node as HTMLInputElement).value)
        .filter(Boolean)
        .slice(0, 100),
    );
    values.forEach((value) => remember(session, value));
    if ((await challenge(page)) || (await paymentPage(page))) {
      await append(session, null, true);
      return;
    }
    const element = await inputTarget(session, input);
    if (!element) return;
    try {
      const target = await fingerprint(session, element);
      if (!target) {
        await append(session, null, true);
        return;
      }
      let kind: RecordingEvent['kind'] | undefined;
      if (['textbox', 'combobox'].includes(target.role)) {
        if (
          input.type === 'text' ||
          (input.type === 'key' &&
            !['Tab', 'Enter', 'Shift', 'Control', 'Meta', 'Alt', 'Escape'].includes(input.key))
        )
          kind = target.role === 'combobox' ? 'select' : 'fill';
      } else if (
        (input.type === 'pointer' && input.button === 'left') ||
        (input.type === 'key' && ['Enter', ' '].includes(input.key))
      )
        kind = 'click';
      if (kind) await append(session, { kind, target, url: null, replay: true });
    } finally {
      await element.dispose();
    }
  }
  async function afterInput(session: BrowserSession) {
    if (!(await active(session))) return;
    // Persist no field values. Re-scrub fingerprints after the latest input entered the redactor.
    const url = safeUrl(session);
    const [row] = await database.orm
      .select()
      .from(browserRecordings)
      .where(
        and(
          eq(browserRecordings.sessionId, session.launch.sessionId),
          eq(browserRecordings.status, 'recording'),
        ),
      )
      .limit(1);
    const lastUrl = row
      ? recordingEventsSchema.parse(row.events).findLast((event) => event.url)?.url
      : null;
    if (
      url &&
      lastUrl !== url &&
      !(await challenge(currentPage(session))) &&
      !(await paymentPage(currentPage(session)))
    )
      await append(session, { kind: 'navigate', target: null, url, replay: false });
    else await append(session, null);
  }
  return { active, initial, beforeInput, afterInput };
}
