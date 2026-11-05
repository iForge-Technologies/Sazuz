import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { normalizeEffect } from '@sazuz/policy';
import type { InfraConfig } from '@sazuz/config';
import {
  McpError,
  externalExecutionSchema,
  externalResultSchema,
  type ExternalExecution,
  type ExternalResult,
} from '@sazuz/core/mcp';
import { ToolError, type RegisteredTool, type ToolContext, type ToolExecution } from '@sazuz/tools';
import { secretRedactor } from '@sazuz/vault';
import {
  boundedJson,
  inputValidator,
  mcpToolName,
  promptSchema,
  untrustedText,
} from './catalogue.js';
import type { SelectedMcp } from './store.js';

export type ExternalDispatch = (
  context: ToolContext,
  tool: string,
  args: unknown,
  verify: boolean,
) => Promise<ExternalResult>;
export const deniedExternalDispatch: ExternalDispatch = () =>
  Promise.reject(new McpError('MCP_DENIED'));

export function mcpTools(
  selections: SelectedMcp[],
  agentId: string,
  dispatch: ExternalDispatch = deniedExternalDispatch,
): RegisteredTool[] {
  return selections.flatMap((selection) =>
    selection.configuration.catalogue.tools.flatMap((remote) => {
      const permission = selection.configuration.permissions.find(
        (entry) => entry.tool === remote.name,
      );
      if (!permission?.enabled || !permission.agents.some((role) => role === agentId)) return [];
      const effect = normalizeEffect(permission.effect ?? undefined),
        name = mcpToolName(selection.serverId, remote.name);
      const validate = inputValidator(remote.inputSchema);
      const parseArgs = (input: unknown) => {
        try {
          return validate(input);
        } catch {
          throw new ToolError('INVALID_TOOL_ARGS');
        }
      };
      const result = (output: unknown): ToolExecution => ({
        output: secretRedactor.redact(output),
        untrusted: true,
      });
      return [
        {
          name,
          description: `Installed MCP tool ${remote.name}. ${untrustedText(remote.description.slice(0, 1700))}`,
          inputSchema: promptSchema(remote.inputSchema),
          effect: effect.effect,
          effectKnown: effect.known,
          scope: 'external' as const,
          connector: selection.serverId,
          moneyMovement: permission.moneyMovement,
          parseArgs,
          async execute(context: ToolContext, input: unknown) {
            if (context.signal.aborted || context.agentId !== agentId)
              throw new ToolError('TOOL_ABORTED');
            const value = await dispatch(context, name, parseArgs(input), false);
            if (value.status !== 'done') throw new ToolError('TOOL_FAILED');
            return result(value.output);
          },
          async verify(context: ToolContext, input: unknown) {
            const value = await dispatch(context, name, parseArgs(input), true);
            return value.status === 'done'
              ? { status: 'done' as const, result: result(value.output) }
              : value;
          },
        },
      ];
    }),
  );
}

export function externalSignature(key: string, message: ExternalExecution): string {
  return createHmac('sha256', Buffer.from(key, 'base64url'))
    .update('sazuz:external-worker:v1\0')
    .update(JSON.stringify(message))
    .digest('hex');
}
export function verifyExternalSignature(
  key: string,
  message: ExternalExecution,
  signature: unknown,
) {
  if (
    typeof signature !== 'string' ||
    !/^[a-f0-9]{64}$/.test(signature) ||
    message.expiresAt <= Date.now() ||
    message.expiresAt > Date.now() + 60_000 ||
    !timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(externalSignature(key, message), 'hex'),
    )
  )
    throw new McpError('MCP_DENIED');
}
export function workerExternalDispatch(options: {
  config: Pick<InfraConfig, 'serverUrl'>;
  workerId: string;
  key(): Promise<string>;
  fetch?: typeof fetch;
}): ExternalDispatch {
  return async (context, tool, args, verify) => {
    const message = externalExecutionSchema.parse({
      workerId: options.workerId,
      runId: context.runId,
      claimKey: context.claimKey,
      callKey: context.idempotencyKey,
      tool,
      args,
      verify,
      nonce: randomUUID(),
      expiresAt: Date.now() + 55_000,
    });
    try {
      const response = await (options.fetch ?? fetch)(
        new URL('/internal/external-execution', options.config.serverUrl),
        {
          method: 'POST',
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            'x-sazuz-worker-signature': externalSignature(await options.key(), message),
          },
          body: JSON.stringify(message),
          signal: AbortSignal.any([context.signal, AbortSignal.timeout(50_000)]),
        },
      );
      if (!response.ok)
        throw new McpError(response.status === 403 ? 'MCP_DENIED' : 'MCP_UNAVAILABLE');
      const text = await response.text();
      if (text.length > 131_072) throw new McpError('MCP_INVALID');
      const value: unknown = JSON.parse(text);
      boundedJson(value, 131_072, 22);
      return externalResultSchema.parse(value);
    } catch (error) {
      if (error instanceof McpError || error instanceof z.ZodError)
        throw new McpError('MCP_UNAVAILABLE');
      throw new McpError('MCP_UNCERTAIN');
    }
  };
}
