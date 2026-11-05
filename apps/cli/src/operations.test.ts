import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { releaseSchema } from '@sazuz/core/operations';
import { boundedInput, runOperationsCli } from './operations.js';
import type * as Config from '@sazuz/config';

const state = vi.hoisted(() => ({ serverUrl: 'http://127.0.0.1:7778' }));
vi.mock('@sazuz/config', async (importOriginal) => {
  const original = await importOriginal<typeof Config>();
  return {
    ...original,
    readInfraConfig: () => original.readInfraConfig({ SAZUZ_SERVER_URL: state.serverUrl }),
    readPlumbing: () =>
      Promise.resolve({
        operatorKey: 'ops-cli-operator-canary',
        sessionKey: 'unused',
        machineKey: Buffer.alloc(32),
        vapidPublicKey: 'unused',
      }),
  };
});
const id = 'op_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const backupId = 'bak_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const operation = {
  id,
  kind: 'backup',
  status: 'done',
  stage: 'done',
  code: null,
  createdAt: '2026-11-05T00:00:00.000Z',
  finishedAt: '2026-11-05T00:00:00.000Z',
};
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const bodyText = (input?: RequestInit) => {
  if (typeof input?.body !== 'string') throw new Error('Expected a JSON request body.');
  return input.body;
};
describe('operation CLI boundaries', () => {
  beforeEach(() => {
    state.serverUrl = 'http://127.0.0.1:7778';
  });
  afterEach(() => vi.unstubAllGlobals());
  it('bounds binary input and leaves caller-owned buffers unchanged', async () => {
    const source = Buffer.from([0, 255, 1, 254]);
    expect(await boundedInput(Readable.from([source]), 4)).toEqual(source);
    await expect(boundedInput(Readable.from([source, source]), 7)).rejects.toMatchObject({
      code: 'OPS_LIMIT',
    });
    expect(source).toEqual(Buffer.from([0, 255, 1, 254]));
  });
  it('streams only checksum-verified ciphertext and waits for the output consumer', async () => {
    const bytes = Buffer.alloc(65550, 193),
      output = vi.fn(),
      sink = vi.fn();
    let saved = Buffer.alloc(0);
    const fetcher = vi.fn((url: URL, input?: RequestInit) => {
      expect(url.origin).toBe('http://127.0.0.1:7778');
      expect(input?.redirect).toBe('error');
      if (url.pathname.endsWith('/download'))
        return Promise.resolve(
          new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }),
        );
      return Promise.resolve(
        json(
          input?.method === 'POST'
            ? operation
            : {
                backups: [
                  {
                    id: backupId,
                    operationId: id,
                    createdAt: operation.createdAt,
                    bytes: bytes.length,
                    sha256: createHash('sha256').update(bytes).digest('hex'),
                    purpose: 'manual',
                    status: 'ready',
                  },
                ],
                operations: [operation],
                maximumBytes: 134217728,
              },
        ),
      );
    });
    vi.stubGlobal('fetch', fetcher);
    await runOperationsCli(
      ['backup', '--stream'],
      () => Promise.reject(new Error('No credential required')),
      output,
      {
        binary: async (value) => {
          await Promise.resolve();
          saved = Buffer.from(value);
          sink();
        },
      },
    );
    expect(saved).toEqual(bytes);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(output).not.toHaveBeenCalled();
  });
  it('resumes the same encrypted upload from the server offset, using bounded chunks', async () => {
    const bytes = Buffer.alloc(70000, 193),
      output = vi.fn();
    let offset = 100;
    const fetcher = vi.fn((url: URL, input?: RequestInit) => {
      const body = JSON.parse(bodyText(input)) as {
        offset?: number;
        data?: string;
        requestId?: string;
      };
      if (url.pathname.endsWith('/chunks')) {
        expect(body.offset).toBe(offset);
        const data = Buffer.from(body.data!, 'base64');
        expect(data.length).toBeLessThanOrEqual(65536);
        expect(data).toEqual(bytes.subarray(offset, offset + data.length));
        offset += data.length;
      } else expect(body.requestId).toMatch(/^[a-f0-9-]{36}$/);
      return Promise.resolve(
        json({
          operation: {
            ...operation,
            kind: 'restore',
            status: offset === bytes.length ? 'ready' : 'uploading',
          },
          receivedBytes: offset,
          bytes: bytes.length,
        }),
      );
    });
    vi.stubGlobal('fetch', fetcher);
    await runOperationsCli(
      ['restore-upload'],
      () => Promise.reject(new Error('No credential in upload')),
      output,
      { input: Readable.from([bytes]) },
    );
    expect(offset).toBe(70000);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(output).toHaveBeenCalledWith(id);
  });
  it('prompts privately only at restore completion and never prints its credential', async () => {
    const credential = 'ops-cli-original-recovery-917263',
      output = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: URL, input?: RequestInit) => {
        expect(JSON.parse(bodyText(input))).toEqual({ credential, confirm: 'restore' });
        return Promise.resolve(json({ ...operation, kind: 'restore' }));
      }),
    );
    await runOperationsCli(['restore-complete', id], () => Promise.resolve(credential), output);
    expect(JSON.stringify(output.mock.calls)).not.toContain(credential);
    await expect(
      runOperationsCli(
        ['restore-complete', id, credential],
        () => Promise.resolve(credential),
        output,
      ),
    ).rejects.toMatchObject({ code: 'OPS_INVALID' });
  });
  it('refuses remote operator access, tagged releases and executable image text', async () => {
    state.serverUrl = 'https://remote.example.test';
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(
      runOperationsCli(['backup', '--stream'], () => Promise.resolve('unused'), vi.fn()),
    ).rejects.toMatchObject({ code: 'OPS_POLICY' });
    expect(fetcher).not.toHaveBeenCalled();
    for (const image of [
      'example/app:latest',
      'example/app@sha256:123',
      '$(touch injected)',
      'https://registry.example/app@sha256:' + 'a'.repeat(64),
    ])
      expect(
        releaseSchema.safeParse({ format: 1, version: '1.0.0', image, notes: 'Release' }).success,
      ).toBe(false);
  });
  it('validates the complete reviewed manifest before requesting an update', async () => {
    const release = {
      format: 1,
      version: '1.0.1',
      image: `ghcr.io/example/sazuz@sha256:${'b'.repeat(64)}`,
      notes: 'Plain release notes',
    };
    const output = vi.fn(),
      fetcher = vi.fn((_url: URL, input?: RequestInit) => {
        expect(JSON.parse(bodyText(input))).toMatchObject({
          release,
          previousImage: `sha256:${'a'.repeat(64)}`,
        });
        return Promise.resolve(
          json({
            operationId: id,
            stage: 'backed-up',
            release,
            previousImage: `sha256:${'a'.repeat(64)}`,
            backupId,
            startedAt: operation.createdAt,
            finishedAt: null,
          }),
        );
      });
    vi.stubGlobal('fetch', fetcher);
    await runOperationsCli(
      ['update-prepare', '--stdin', `sha256:${'a'.repeat(64)}`],
      () => Promise.reject(new Error('No credential')),
      output,
      { input: Readable.from([Buffer.from(JSON.stringify(release))]) },
    );
    expect(output).toHaveBeenCalledWith(release.image);
    await expect(
      runOperationsCli(
        ['update-prepare', '--stdin', `sha256:${'a'.repeat(64)}`],
        () => Promise.resolve('unused'),
        output,
        {
          input: Readable.from([Buffer.from(JSON.stringify({ ...release, image: 'app:latest' }))]),
        },
      ),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
