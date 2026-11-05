import { readOperatorKey, type InfraConfig } from '@sazuz/config';
import { installations, type Database } from '@sazuz/db';
import { consumeExecutionSecret, makeExecutionRequest, type ExecutionRequest } from '@sazuz/vault';
import { z } from 'zod';
import { RunSuspension } from './contracts.js';

export type ExecutionScope = Pick<ExecutionRequest, 'runId' | 'claimKey' | 'scope' | 'executionId'>;
export function createExecutionBroker(
  database: Database,
  config: InfraConfig,
  workerId: string,
  fetcher: typeof fetch = fetch,
) {
  let credentials: Promise<{ workspaceId: string; operatorKey: string }> | undefined;
  async function identity() {
    credentials ??= (async () => {
      const [installation] = await database.orm.select().from(installations).limit(1);
      if (!installation)
        throw new RunSuspension('paused', 'Complete setup before running missions.');
      const operatorKey = await readOperatorKey(config.dataDir);
      return { workspaceId: installation.workspaceId, operatorKey };
    })();
    try {
      return await credentials;
    } catch (error) {
      credentials = undefined;
      throw error;
    }
  }
  async function send(reference: string | null, scope: ExecutionScope, signal?: AbortSignal) {
    const { workspaceId, operatorKey } = await identity();
    const { request, signature } = makeExecutionRequest(operatorKey, {
      workspaceId,
      workerId,
      reference,
      ...scope,
    });
    let response: Response;
    try {
      response = await fetcher(new URL('/internal/execution', config.serverUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sazuz-worker-signature': signature },
        body: JSON.stringify(request),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
          : AbortSignal.timeout(10000),
        redirect: 'error',
      });
    } catch {
      throw new RunSuspension(
        'paused',
        'The vault service is unavailable. Resume after it is reachable.',
      );
    }
    if (!response.ok)
      throw new RunSuspension(
        'paused',
        'Unlock the vault and verify connector access before resuming.',
      );
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new RunSuspension('paused', 'The execution credential response was invalid.');
    }
    return { operatorKey, request, body };
  }
  return {
    async ready(scope: ExecutionScope, signal?: AbortSignal) {
      const { body } = await send(null, scope, signal);
      if (!z.strictObject({ ready: z.literal(true) }).safeParse(body).success)
        throw new RunSuspension('paused', 'Unlock the vault before resuming.');
    },
    async secret<T>(
      reference: string,
      scope: ExecutionScope,
      consume: (value: string) => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T> {
      const { operatorKey, request, body } = await send(reference, scope, signal);
      return consumeExecutionSecret(operatorKey, request, body, consume);
    },
  };
}
