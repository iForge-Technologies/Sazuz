import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { browserActionInputs, browserSiteSchema } from '@sazuz/core/browser';
import { consumeBrowserValue, sealBrowserValue, type BrowserBinding } from '@sazuz/vault';
import { rpcMessage, scopedStorage, signBrowserMessage, verifyBrowserMessage } from './protocol.js';

describe('browser boundaries and execution-bound encryption', () => {
  const key = randomBytes(32).toString('base64url');
  it('binds service authentication to the complete request, purpose and deadline', () => {
    const request = rpcMessage({ mode: 'health' }),
      signature = signBrowserMessage(key, 'service', request);
    expect(() => verifyBrowserMessage(key, 'service', request, signature)).not.toThrow();
    expect(() => verifyBrowserMessage(key, 'worker', request, signature)).toThrow();
    expect(() =>
      verifyBrowserMessage(key, 'service', { ...request, mode: 'close' }, signature),
    ).toThrow();
    expect(() =>
      verifyBrowserMessage(key, 'service', { ...request, expiresAt: Date.now() - 1 }, signature),
    ).toThrow();
  });
  it('rejects cross-site cookies, insecure cookies and additional stored origins', () => {
    const state = {
      cookies: [
        {
          name: 'session',
          value: 'private-cookie-value',
          domain: '.fixture.example',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: 'Strict',
        },
      ],
      origins: [],
    };
    expect(scopedStorage(state, 'https://fixture.example').cookies).toHaveLength(1);
    expect(() => scopedStorage(state, 'https://other.example')).toThrow();
    expect(() =>
      scopedStorage(
        { ...state, cookies: [{ ...state.cookies[0], secure: false }] },
        'https://fixture.example',
      ),
    ).toThrow();
    expect(() =>
      scopedStorage(
        { ...state, origins: [{ origin: 'https://other.example', localStorage: [] }] },
        'https://fixture.example',
      ),
    ).toThrow();
  });
  it('encrypts form values and prevents capsule swaps between calls and profiles', async () => {
    const binding: BrowserBinding = {
      sessionId: 'session',
      runId: 'run',
      callKey: 'run:1:0',
      site: 'https://fixture.example',
      purpose: 'secret',
      nonce: randomUUID(),
      expiresAt: Date.now() + 10000,
    };
    const { site, ...rest } = binding;
    const canary = 'browser-form-canary-8348912',
      capsule = await sealBrowserValue(key, { site, ...rest }, canary);
    expect(JSON.stringify(capsule)).not.toContain(canary);
    expect(
      await consumeBrowserValue(key, binding, capsule, (value) => Promise.resolve(value)),
    ).toBe(canary);
    const { expiresAt, ...remaining } = capsule.binding;
    expect(
      await consumeBrowserValue(
        key,
        binding,
        { ...capsule, binding: { expiresAt, ...remaining } },
        (value) => Promise.resolve(value),
      ),
    ).toBe(canary);
    await expect(
      consumeBrowserValue(key, { ...binding, callKey: 'run:2:0' }, capsule, (value) =>
        Promise.resolve(value),
      ),
    ).rejects.toThrow();
    await expect(
      consumeBrowserValue(key, { ...binding, site: 'https://other.example' }, capsule, (value) =>
        Promise.resolve(value),
      ),
    ).rejects.toThrow();
  });
  it('admits exact HTTPS sites and secret handles without arbitrary scripts or paths', () => {
    for (const site of [
      'http://example.com',
      'https://example.com/path',
      'https://user:pw@example.com',
      'https://127.0.0.1',
      'https://example.com:8443',
    ])
      expect(browserSiteSchema.safeParse(site).success).toBe(false);
    expect(browserSiteSchema.safeParse('https://example.com').success).toBe(true);
    expect(
      browserActionInputs.read.safeParse({
        sessionId: 'bsn_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        script: 'document.cookie',
      }).success,
    ).toBe(false);
    expect(
      browserActionInputs.upload.safeParse({
        sessionId: 'bsn_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        ref: 'r1e1',
        fileHandle: '../../secrets',
      }).success,
    ).toBe(false);
  });
});
