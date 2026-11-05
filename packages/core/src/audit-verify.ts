import { createHash } from 'node:crypto';
import {
  auditBundleSchema,
  auditExportSchema,
  auditPayloadSchema,
  type AuditExport,
} from './audit.js';

export const auditGenesis = { sequence: 0, hash: '0'.repeat(64) };
export function auditDigest(previousHash: string, canonical: string): string {
  return createHash('sha256')
    .update(`sazuz:audit:v1:${previousHash}${canonical}`, 'utf8')
    .digest('hex');
}

/** A retained external head is needed to detect replacement of the entire database history. */
export function verifyAuditExport(input: unknown, expectedHead?: AuditExport['head']): boolean {
  const parsed = auditExportSchema.safeParse(input);
  if (!parsed.success) return false;
  const page = parsed.data;
  if (page.start.sequence === 0 && page.start.hash !== auditGenesis.hash) return false;
  if (
    expectedHead &&
    (page.head.sequence !== expectedHead.sequence || page.head.hash !== expectedHead.hash)
  )
    return false;
  let previous = page.start;
  for (const entry of page.entries) {
    try {
      const payload = auditPayloadSchema.parse(JSON.parse(entry.canonical));
      if (JSON.stringify(payload) !== JSON.stringify(entry.payload)) return false;
    } catch {
      return false;
    }
    if (
      entry.sequence !== previous.sequence + 1 ||
      entry.previousHash !== previous.hash ||
      entry.hash !== auditDigest(entry.previousHash, entry.canonical)
    )
      return false;
    previous = { sequence: entry.sequence, hash: entry.hash };
  }
  if (previous.sequence > page.head.sequence) return false;
  if (page.complete !== (previous.sequence === page.head.sequence)) return false;
  return !page.complete || previous.hash === page.head.hash;
}

export function verifyAuditBundle(input: unknown, expectedHead?: AuditExport['head']): boolean {
  const parsed = auditBundleSchema.safeParse(input);
  if (!parsed.success) return false;
  const bundle = parsed.data;
  if (
    expectedHead &&
    (bundle.head.sequence !== expectedHead.sequence || bundle.head.hash !== expectedHead.hash)
  )
    return false;
  let last = auditGenesis;
  for (const [index, page] of bundle.pages.entries()) {
    if (
      page.start.sequence !== last.sequence ||
      page.start.hash !== last.hash ||
      !verifyAuditExport(page, bundle.head) ||
      (page.complete && index !== bundle.pages.length - 1)
    )
      return false;
    const entry = page.entries.at(-1);
    if (entry) last = { sequence: entry.sequence, hash: entry.hash };
  }
  return (
    bundle.pages.at(-1)?.complete === true &&
    last.sequence === bundle.head.sequence &&
    last.hash === bundle.head.hash
  );
}
