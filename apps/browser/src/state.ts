import { browserStorageSchema, scopedStorage } from '@sazuz/browser/protocol';
import { remember, type BrowserSession } from './session.js';

/** Read only existing pages. Playwright storageState() may create a temporary page in the tab pool. */
export async function captureSensitiveState(session: BrowserSession) {
  const cookies = browserStorageSchema.shape.cookies.parse(await session.context.cookies());
  session.sensitive ||= cookies.length > 0;
  for (const cookie of cookies) remember(session, cookie.value);
  const origins = [...session.storage.origins];
  for (const page of session.pages.values())
    for (const frame of page.frames()) {
      let origin: string;
      try {
        const url = new URL(frame.url());
        if (url.protocol !== 'https:') continue;
        origin = url.origin;
      } catch {
        continue;
      }
      try {
        const localStorage = await frame.evaluate(() =>
          Object.keys(window.localStorage).map((name) => ({
            name,
            value: window.localStorage.getItem(name) ?? '',
          })),
        );
        const parsed = browserStorageSchema.shape.origins.element.parse({ origin, localStorage });
        session.sensitive ||= parsed.localStorage.length > 0;
        for (const entry of parsed.localStorage) remember(session, entry.value);
        if (origin === session.launch.site) {
          origins.splice(0, origins.length, parsed);
        }
      } catch {
        session.opaque = true;
        session.sensitive = true;
      }
    }
  const host = new URL(session.launch.site).hostname;
  session.storage = scopedStorage(
    {
      cookies: cookies.filter(
        (cookie) => cookie.domain.replace(/^\./, '') === host && cookie.secure,
      ),
      origins,
    },
    session.launch.site,
  );
  for (const value of session.fields.values()) remember(session, value);
}
