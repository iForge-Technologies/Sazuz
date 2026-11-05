import { describe, expect, it } from 'vitest';
import { auditBundleSchema, passkeyAuthenticationSchema } from './audit.js';
import { auditDigest, auditGenesis, verifyAuditBundle, verifyAuditExport } from './audit-verify.js';

describe('independent audit verification', () => {
  const payload: [string, string, string, string, string] = [
    'aud_example',
    'owner',
    'test',
    'target',
    '2026-11-05T10:00:00.000000Z',
  ];
  const canonical = JSON.stringify(payload);
  const hash = auditDigest(auditGenesis.hash, canonical);
  const page = {
    format: 'sazuz-audit-v1',
    start: auditGenesis,
    head: { sequence: 1, hash },
    complete: true,
    entries: [{ sequence: 1, payload, canonical, previousHash: auditGenesis.hash, hash }],
  };
  it('requires exact signed payload bytes and the retained head', () => {
    expect(verifyAuditExport(page, page.head)).toBe(true);
    expect(
      verifyAuditExport({ ...page, entries: [{ ...page.entries[0], canonical: canonical + ' ' }] }),
    ).toBe(false);
    expect(verifyAuditExport({ ...page, complete: false })).toBe(false);
    expect(verifyAuditExport({ ...page, entries: [] })).toBe(false);
    expect(
      verifyAuditExport({ ...page, entries: [{ ...page.entries[0], canonical: 'not json' }] }),
    ).toBe(false);
    expect(verifyAuditExport({ ...page, entries: [{ ...page.entries[0], sequence: 2 }] })).toBe(
      false,
    );
  });
  it('requires complete, contiguous bundles starting at genesis', () => {
    const bundle = auditBundleSchema.parse({
      format: 'sazuz-audit-bundle-v1',
      head: page.head,
      pages: [page],
    });
    expect(verifyAuditBundle(bundle, page.head)).toBe(true);
    expect(verifyAuditBundle({ ...bundle, pages: [page, page] })).toBe(false);
    expect(verifyAuditBundle({ ...bundle, pages: [] })).toBe(false);
    expect(verifyAuditBundle({ ...bundle, head: { ...page.head, hash: 'f'.repeat(64) } })).toBe(
      false,
    );
    expect(
      verifyAuditExport({
        format: 'sazuz-audit-v1',
        start: auditGenesis,
        head: auditGenesis,
        entries: [],
        complete: true,
      }),
    ).toBe(true);
  });
  it('rejects unknown credential options and excessive binary input', () => {
    expect(
      passkeyAuthenticationSchema.safeParse({ response: { id: 'a'.repeat(70000) } }).success,
    ).toBe(false);
    expect(
      passkeyAuthenticationSchema.safeParse({ response: {}, origin: 'https://evil.example' })
        .success,
    ).toBe(false);
  });
});
