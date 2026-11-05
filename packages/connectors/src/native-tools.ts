import { z } from 'zod';
import type { RegisteredTool, ToolContext } from '@sazuz/tools';
import type {
  ConnectorAccount,
  ConnectorDependencies,
  ConnectorProvider,
  ConnectorPermission,
} from './contracts.js';
import { ConnectorError } from './errors.js';
import { accountInput, defineAccountTool } from './sdk.js';
import { nativeRequest, remoteResult, remoteJson, recordResponse } from './native-http.js';

export const nativeId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_!.-]+$/)
  .refine((value) => value !== '.' && value !== '..');
export const boundedText = z.string().min(1).max(60_000);
export const nativeLimit = z.number().int().min(1).max(100).default(20);
export const nativeAccount = accountInput;
export const jsonRecord = recordResponse;
export const jsonList = z.array(recordResponse).max(1000);

export function nativeTool<Input extends z.ZodType>(
  dependencies: ConnectorDependencies,
  definition: {
    provider: ConnectorProvider;
    permission: ConnectorPermission;
    name: string;
    description: string;
    effect: 'read' | 'write' | 'send' | 'delete';
    input: Input;
    response?: z.ZodType;
    request: (
      context: ToolContext,
      account: ConnectorAccount,
      args: z.output<Input>,
      call: (url: string, init?: Parameters<typeof nativeRequest>[5]) => Promise<unknown>,
    ) => Promise<unknown>;
  },
): RegisteredTool {
  return defineAccountTool(dependencies, {
    ...definition,
    roles: ['chief-of-staff', 'researcher', 'comms', 'coder'],
    output: remoteResult,
    run: async (context, account, args) => {
      const value = await definition.request(context, account, args, (url, init) =>
        nativeRequest(dependencies, context, account, new URL(url), args, init),
      );
      if (definition.provider === 'microsoft-graph') removeDownloadCapabilities(value);
      const result = (definition.response ?? remoteJson).safeParse(value);
      if (!result.success) throw new ConnectorError('INVALID_RESPONSE');
      return { data: remoteJson.parse(result.data) };
    },
    // An API response lost before the durable result is recorded is not proof of non-execution.
    ...(definition.effect === 'read'
      ? {}
      : { verify: () => Promise.resolve({ status: 'unknown' } as const) }),
  });
}

function removeDownloadCapabilities(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) removeDownloadCapabilities(entry);
  } else if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (key === '@microsoft.graph.downloadUrl') Reflect.deleteProperty(value, key);
      else removeDownloadCapabilities(Reflect.get(value, key));
    }
  }
}
