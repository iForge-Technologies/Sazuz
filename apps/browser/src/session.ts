import type { BrowserContext, CDPSession, ElementHandle, Page } from 'playwright';
import type { SecretRedactor } from '@sazuz/vault';
import type { BrowserLaunch, BrowserStorage } from '@sazuz/browser/protocol';
import type { BrowserChallenge } from './types.js';

export interface ElementReference {
  element: ElementHandle;
  role: string;
  name: string;
  fingerprint: string;
}
export interface BrowserSession {
  launch: BrowserLaunch;
  storage: BrowserStorage;
  context: BrowserContext;
  pages: Map<number, Page>;
  nextTab: number;
  activeTab: number;
  revision: number;
  signature: string;
  refs: Map<string, ElementReference>;
  redactor: SecretRedactor;
  redactions: Set<string>;
  fields: Map<string, string>;
  opaque: boolean;
  sensitive: boolean;
  challenge: BrowserChallenge | null;
  control: 'agent' | 'human';
  handbackVersion?: number;
  files: Map<string, { name: string; content: Buffer; sha256: string }>;
  images: Map<string, { data: string; expiresAt: number }>;
  cdp?: CDPSession;
  cdpPage?: Page;
}
type SessionRedaction = Pick<BrowserSession, 'redactions' | 'redactor' | 'opaque' | 'sensitive'>;
export function remember(session: SessionRedaction, value: string) {
  if (!value) return;
  if (value.length > 8000) {
    session.opaque = true;
    session.sensitive = true;
    return;
  }
  if (session.redactions.size >= 256 && !session.redactions.has(value)) {
    session.opaque = true;
    session.sensitive = true;
    return;
  }
  if (!session.redactions.has(value)) {
    session.redactions.add(value);
    session.redactor.register(value);
    if (value.length >= 4) session.redactor.register(Buffer.from(value).toString('base64'));
  }
}
export function scrub(session: SessionRedaction, value: string, limit: number) {
  if (session.opaque) return '[Sensitive content withheld]';
  return session.redactor.redactText(value).slice(0, limit);
}
export function currentPage(session: BrowserSession): Page {
  const page = session.pages.get(session.activeTab);
  if (!page || page.isClosed()) throw new Error('The active browser tab is unavailable.');
  return page;
}
