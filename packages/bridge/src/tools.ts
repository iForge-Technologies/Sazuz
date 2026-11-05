import { z } from 'zod';
import { BridgeError, bridgeInputs, bridgeToolSchema, type BridgeTool } from '@sazuz/core/bridge';
import type { ExternalDispatch } from '@sazuz/mcp';
import { secretRedactor } from '@sazuz/vault';
import type { ToolContext, ToolExecution, RegisteredTool } from '@sazuz/tools';
import { assertBridgeScope, type SelectedBridge } from './store.js';

const descriptions: Record<BridgeTool, string> = {
  'local.fs.list': 'List at most 100 ordinary entries in an authorized laptop folder.',
  'local.fs.read':
    'Read at most 4096 UTF-8 bytes from an authorized laptop file; offset supports bounded continuation.',
  'local.fs.write':
    'Replace or create one UTF-8 file of at most 4096 bytes in an authorized writable laptop folder.',
  'local.fs.move':
    'Move one ordinary file within the same authorized folder without replacing an occupied destination.',
  'local.fs.delete':
    'Delete one ordinary file when both laptop and server explicitly permit deletion.',
  'local.exec':
    'Execute one fixed command alias configured on the laptop. No arguments or shell source may be supplied. Always requires approval.',
  'local.notify': 'Submit a native laptop notification using its enabled notification backend.',
};
const effects = {
  'local.fs.list': 'read',
  'local.fs.read': 'read',
  'local.fs.write': 'write',
  'local.fs.move': 'write',
  'local.fs.delete': 'delete',
  'local.exec': 'write',
  'local.notify': 'send',
} as const;
const denied: ExternalDispatch = () => Promise.reject(new BridgeError('BRIDGE_DENIED'));
export function bridgeTools(
  selections: SelectedBridge[],
  agentId: string,
  dispatch: ExternalDispatch = denied,
): RegisteredTool[] {
  return bridgeToolSchema.options.flatMap((name) => {
    const available = selections.filter(
      (selection) =>
        selection.grant.agents.some((role) => role === agentId) &&
        selection.grant.tools.includes(name),
    );
    if (!available.length) return [];
    const schema = bridgeInputs[name];
    const select = (input: unknown) => {
      const args = schema.parse(input),
        selection = available.find((item) => item.deviceId === args.deviceId);
      if (!selection || JSON.stringify(args) !== JSON.stringify(secretRedactor.redact(args)))
        throw new BridgeError('BRIDGE_DENIED');
      assertBridgeScope(selection, agentId, name, args);
      return { args, selection };
    };
    const result = (output: unknown, selection: SelectedBridge): ToolExecution => ({
      output: secretRedactor.redact(output),
      untrusted: true,
      privateOnly: selection.grant.privateOnly,
    });
    const scopes = available.map((item) => ({
      deviceId: item.deviceId,
      folders: item.grant.folders.map((entry) => entry.alias),
      commands: item.grant.commands,
    }));
    return [
      {
        name,
        description:
          `${descriptions[name]} Available device scopes: ${JSON.stringify(scopes)}`.slice(0, 2000),
        inputSchema: z.toJSONSchema(schema, { io: 'input' }),
        effect: effects[name],
        effectKnown: name !== 'local.exec',
        scope: 'external' as const,
        connector: 'bridge',
        parseArgs: (input: unknown) => select(input).args,
        async execute(context: ToolContext, input: unknown) {
          if (context.agentId !== agentId || context.signal.aborted)
            throw new BridgeError('BRIDGE_DENIED');
          const { args, selection } = select(input),
            value = await dispatch(context, name, args, false);
          if (value.status !== 'done') throw new BridgeError('BRIDGE_UNCERTAIN');
          return result(value.output, selection);
        },
        async verify(context: ToolContext, input: unknown) {
          const { args, selection } = select(input),
            value = await dispatch(context, name, args, true);
          return value.status === 'done'
            ? { status: 'done' as const, result: result(value.output, selection) }
            : value;
        },
      },
    ];
  });
}
