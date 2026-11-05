import { z } from 'zod';
import {
  BridgeError,
  bridgeInputs,
  bridgeRequestSchema,
  type BridgeRequest,
} from '@sazuz/core/bridge';
import { externalResultSchema, type ExternalResult } from '@sazuz/core/mcp';
import { secretRedactor } from '@sazuz/vault';
import { digest, localPin } from './local-config.js';
import { executeFile, checkSignal } from './filesystem.js';
import { executeCommand, notifyLocal } from './commands.js';
import type { BridgeState } from './state.js';

const receiptSchema = z.strictObject({
  key: z.string(),
  hash: z.string(),
  result: externalResultSchema.optional(),
});
export const requestHash = (request: BridgeRequest) =>
  digest(
    JSON.stringify({
      deviceId: request.deviceId,
      projectId: request.projectId,
      agentId: request.agentId,
      pin: request.pin,
      tool: request.tool,
      args: request.args,
    }),
  );
export function createLocalExecutor(state: BridgeState, notify = notifyLocal) {
  let active = false;
  return async (input: unknown, signal: AbortSignal): Promise<ExternalResult> => {
    const request = bridgeRequestSchema.parse(input);
    const args = bridgeInputs[request.tool].parse(request.args);
    if (JSON.stringify(args) !== JSON.stringify(secretRedactor.redact(args)))
      throw new BridgeError('BRIDGE_DENIED');
    if (request.deadline <= Date.now() || request.deadline > Date.now() + 45000)
      throw new BridgeError('BRIDGE_DENIED');
    const abort = AbortSignal.any([
      signal,
      AbortSignal.timeout(Math.max(1, request.deadline - Date.now())),
    ]);
    checkSignal(abort);
    if (active) throw new BridgeError('BRIDGE_UNAVAILABLE');
    active = true;
    try {
      await state.withPairing((pairing) => {
        if (
          pairing.deviceId !== request.deviceId ||
          pairing.projectId !== request.projectId ||
          args.deviceId !== pairing.deviceId
        )
          throw new BridgeError('BRIDGE_DENIED');
        return Promise.resolve();
      });
      const config = await state.configuration();
      if (localPin(config) !== request.pin) throw new BridgeError('BRIDGE_CHANGED');
      const hash = requestHash(request),
        startName = state.receiptName(request.key, 'start'),
        doneName = state.receiptName(request.key, 'done');
      const done = await state.read(doneName, receiptSchema),
        start = await state.read(startName, receiptSchema);
      for (const prior of [start, done])
        if (prior && (prior.key !== request.key || prior.hash !== hash))
          throw new BridgeError('BRIDGE_DENIED');
      if (done?.result) return done.result;
      if (start) return { status: 'unknown' };
      if (request.verify) return { status: 'not_done' };
      checkSignal(abort);
      // Only one process can claim this immutable start record. No action precedes its fsync.
      if (!(await state.write(startName, { key: request.key, hash }))) return { status: 'unknown' };
      if (localPin(await state.configuration()) !== request.pin)
        throw new BridgeError('BRIDGE_CHANGED');
      checkSignal(abort);
      let output: unknown;
      if (request.tool === 'local.exec') {
        output = await executeCommand(
          config,
          state.directory,
          bridgeInputs['local.exec'].parse(args).command,
          abort,
        );
      } else if (request.tool === 'local.notify') {
        if (!config.notifications) throw new BridgeError('BRIDGE_DENIED');
        const message = bridgeInputs['local.notify'].parse(args);
        output = await notify(message.title, message.message, abort);
      } else output = await executeFile(config, state.directory, request.tool, args, abort);
      const result = externalResultSchema.parse({
        status: 'done',
        output: secretRedactor.redact(output),
      });
      if (Buffer.byteLength(JSON.stringify(result)) > 12000)
        throw new BridgeError('BRIDGE_INVALID');
      if (!(await state.write(doneName, { key: request.key, hash, result })))
        throw new BridgeError('BRIDGE_UNCERTAIN');
      return result;
    } finally {
      active = false;
    }
  };
}
