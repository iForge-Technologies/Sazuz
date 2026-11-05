import { z } from 'zod';
import { agentRoleSchema } from './agents';
import { workId } from './work';
import { externalResultSchema } from './mcp';

export const bridgeAliasSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
export const bridgePinSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const bridgeToolSchema = z.enum([
  'local.fs.list',
  'local.fs.read',
  'local.fs.write',
  'local.fs.move',
  'local.fs.delete',
  'local.exec',
  'local.notify',
]);
export type BridgeTool = z.infer<typeof bridgeToolSchema>;
const unique = <T>(items: T[]) => new Set(items).size === items.length;
export const bridgeFolderSchema = z.strictObject({
  alias: bridgeAliasSchema,
  mode: z.enum(['read', 'write']),
  delete: z.boolean().default(false),
});
export const bridgeManifestSchema = z.strictObject({
  folders: z
    .array(bridgeFolderSchema)
    .max(16)
    .refine((items) => unique(items.map((item) => item.alias))),
  commands: z.array(bridgeAliasSchema).max(16).refine(unique),
  notifications: z.boolean().default(false),
  privateOnly: z.boolean().default(true),
});
export const bridgeGrantSchema = bridgeManifestSchema.extend({
  pin: bridgePinSchema,
  agents: z.array(agentRoleSchema).max(10).refine(unique),
  tools: z.array(bridgeToolSchema).max(7).refine(unique),
});
export const bridgeDeviceInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  projectId: workId,
  secretRef: z.string().regex(/^secret:\/\/sec_[0-9A-HJKMNP-TV-Z]{26}$/),
});
export const bridgeSaveSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  grant: bridgeGrantSchema,
});
export const bridgeDeviceSchema = bridgeDeviceInputSchema.extend({
  id: workId,
  version: z.number().int().positive(),
  enabled: z.boolean(),
  online: z.boolean(),
  lastSeenAt: z.iso.datetime().nullable(),
  offeredPin: bridgePinSchema.nullable(),
  offered: bridgeManifestSchema.nullable(),
  grant: bridgeGrantSchema.nullable(),
});
export type BridgeManifest = z.infer<typeof bridgeManifestSchema>;
export type BridgeGrant = z.infer<typeof bridgeGrantSchema>;

// Portable relative names only: no drive/ADS/device names, dot segments or separator ambiguity.
export const bridgePathSchema = z
  .string()
  .max(1024)
  .refine(
    (value) =>
      value === '' ||
      value
        .split('/')
        .every(
          (part) =>
            part.length > 0 &&
            part.length <= 255 &&
            part !== '.' &&
            part !== '..' &&
            !/[\\:<>"|?*]/.test(part) &&
            !/[. ]$/.test(part) &&
            [...part].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) &&
            !/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part),
        ),
  );
const filePath = bridgePathSchema.refine((value) => value.length > 0);
const base = { deviceId: workId, folder: bridgeAliasSchema };
export const bridgeInputs = {
  'local.fs.list': z.strictObject({ ...base, path: bridgePathSchema.default('') }),
  'local.fs.read': z.strictObject({
    ...base,
    path: filePath,
    offset: z.number().int().min(0).max(10_485_760).default(0),
  }),
  'local.fs.write': z.strictObject({ ...base, path: filePath, content: z.string().max(4096) }),
  'local.fs.move': z.strictObject({ ...base, path: filePath, destination: filePath }),
  'local.fs.delete': z.strictObject({ ...base, path: filePath }),
  'local.exec': z.strictObject({ deviceId: workId, command: bridgeAliasSchema }),
  'local.notify': z.strictObject({
    deviceId: workId,
    title: z.string().min(1).max(100),
    message: z.string().min(1).max(1000),
  }),
};
export const bridgeRequestSchema = z.strictObject({
  type: z.literal('request'),
  id: z.uuid(),
  deviceId: workId,
  projectId: workId,
  agentId: agentRoleSchema,
  key: z.string().min(1).max(256),
  pin: bridgePinSchema,
  tool: bridgeToolSchema,
  args: z.record(z.string(), z.json()),
  version: z.number().int().positive(),
  deadline: z.number().int().positive(),
  verify: z.boolean(),
});
export const bridgeResponseSchema = z.strictObject({
  type: z.literal('result'),
  id: z.uuid(),
  result: externalResultSchema,
});
export const bridgeHelloSchema = z.strictObject({
  type: z.literal('hello'),
  pin: bridgePinSchema,
  manifest: bridgeManifestSchema,
});
export const bridgeReadySchema = z.strictObject({
  type: z.literal('ready'),
  deviceId: workId,
  projectId: workId,
  pin: bridgePinSchema,
});
export const bridgeCancelSchema = z.strictObject({ type: z.literal('cancel'), id: z.uuid() });
export const bridgeEndpointSchema = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === 'wss:' ||
        (url.protocol === 'ws:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) &&
      url.pathname === '/bridge' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  });
export type BridgeRequest = z.infer<typeof bridgeRequestSchema>;
export class BridgeError extends Error {
  constructor(
    readonly code:
      | 'BRIDGE_INVALID'
      | 'BRIDGE_DENIED'
      | 'BRIDGE_CHANGED'
      | 'BRIDGE_CONFLICT'
      | 'BRIDGE_UNAVAILABLE'
      | 'BRIDGE_UNCERTAIN',
  ) {
    super(
      {
        BRIDGE_INVALID:
          'The Bridge configuration, path or response is invalid or exceeds its limits.',
        BRIDGE_DENIED: 'This Bridge action is outside the current local or server grant.',
        BRIDGE_CHANGED:
          'The local configuration changed. Review the new pin and start a new mission.',
        BRIDGE_CONFLICT: 'The Bridge device changed. Reload before saving.',
        BRIDGE_UNAVAILABLE: 'The Bridge is offline, busy or unavailable.',
        BRIDGE_UNCERTAIN: 'The local action may have completed. Reconcile it before retrying.',
      }[code],
    );
    this.name = 'BridgeError';
  }
}
