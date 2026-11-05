import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  makeExecutionRequest,
  verifyExecutionRequest,
  sealExecutionSecret,
  consumeExecutionSecret,
} from './execution.js';

describe('scoped worker secret capsules', () => {
  const root = randomBytes(32).toString('base64url');
  const now = Date.now();
  const signed = () =>
    makeExecutionRequest(
      root,
      {
        workspaceId: 'ws_test',
        workerId: 'wrk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        runId: 'run_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        claimKey: crypto.randomUUID(),
        scope: 'model',
        executionId: 'model:1',
        reference: 'secret://sec_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      },
      now,
    );
  it('authenticates without transmitting the operator key and returns only encrypted secrets', async () => {
    const { request, signature } = signed();
    expect(JSON.stringify({ request, signature })).not.toContain(root);
    expect(verifyExecutionRequest(root, request, signature, now)).toEqual(request);
    const capsule = await sealExecutionSecret(root, request, 'capsule-private-value-9429', now);
    expect(JSON.stringify(capsule)).not.toContain('capsule-private-value-9429');
    await expect(
      consumeExecutionSecret(
        root,
        request,
        capsule,
        (value) => Promise.resolve(value === 'capsule-private-value-9429'),
        now,
      ),
    ).resolves.toBe(true);
  });
  it('rejects tampering, expired requests, wrong keys and cross-claim/reference capsules', async () => {
    const { request, signature } = signed();
    expect(() =>
      verifyExecutionRequest(root, { ...request, executionId: 'different' }, signature, now),
    ).toThrow();
    expect(() => verifyExecutionRequest(root, request, signature, now + 10_001)).toThrow();
    const capsule = await sealExecutionSecret(root, request, 'private-value-9823', now);
    for (const expected of [
      { ...request, claimKey: crypto.randomUUID() },
      { ...request, scope: 'tool' as const },
      { ...request, reference: null },
    ])
      await expect(
        consumeExecutionSecret(root, expected, capsule, () => Promise.resolve(true), now),
      ).rejects.toThrow();
    await expect(
      consumeExecutionSecret(
        randomBytes(32).toString('base64url'),
        request,
        capsule,
        () => Promise.resolve(true),
        now,
      ),
    ).rejects.toThrow();
    await expect(
      consumeExecutionSecret(root, request, capsule, () => Promise.resolve(true), now + 10_001),
    ).rejects.toThrow();
  });
});
