import Docker from 'dockerode';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { InfraConfig } from '@sazuz/config';
import { SandboxError } from '@sazuz/core/sandbox';
import type { ContainerSpec } from './container.js';

const inspectionSchema = z.object({
  Name: z.string(),
  Config: z.object({
    Labels: z.record(z.string(), z.string()).nullable(),
    Env: z.array(z.string().max(20000)).max(100).optional(),
  }),
  State: z.object({
    Running: z.boolean(),
    ExitCode: z.number().int(),
    Status: z.string(),
    OOMKilled: z.boolean().optional(),
  }),
});
export type ContainerInspection = z.infer<typeof inspectionSchema>;
export interface ContainerEngine {
  inspect(name: string): Promise<ContainerInspection | null>;
  create(name: string, spec: ContainerSpec): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  logs(name: string): Promise<Buffer>;
  remove(name: string): Promise<void>;
}
function missing(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 404
  );
}
export function dockerEngine(config: InfraConfig, token: string): ContainerEngine {
  const url = new URL(config.dockerProxyUrl);
  const docker = new Docker({
    host: url.hostname,
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    protocol: url.protocol === 'https:' ? 'https' : 'http',
    version: 'v1.47',
    headers: { 'x-sazuz-capability': token },
    timeout: 10_000,
  });
  return {
    async inspect(name) {
      try {
        return inspectionSchema.parse(await docker.getContainer(name).inspect());
      } catch (error) {
        if (missing(error)) return null;
        throw new SandboxError('SANDBOX_UNAVAILABLE');
      }
    },
    async create(name, spec) {
      try {
        const body = {
          ...spec,
          HostConfig: {
            ...spec.HostConfig,
            Mounts: spec.HostConfig.Mounts.filter((mount) => mount !== undefined),
          },
        };
        // docker-modem 5 otherwise duplicates the container body into the URL query.
        const options = { ...body, _query: { name }, _body: body };
        await docker.createContainer(options);
      } catch {
        throw new SandboxError('SANDBOX_UNAVAILABLE');
      }
    },
    async start(name) {
      try {
        await docker.getContainer(name).start();
      } catch {
        throw new SandboxError('SANDBOX_UNCERTAIN');
      }
    },
    async stop(name) {
      try {
        await docker.getContainer(name).kill();
      } catch (error) {
        if (missing(error) || !(await this.inspect(name))?.State.Running) return;
        throw new SandboxError('SANDBOX_UNAVAILABLE');
      }
    },
    async logs(name) {
      try {
        const value: unknown = await docker
          .getContainer(name)
          .logs({ stdout: true, stderr: true, follow: false, tail: 1000 });
        if (!Buffer.isBuffer(value)) throw new SandboxError('SANDBOX_INVALID');
        return value;
      } catch {
        throw new SandboxError('SANDBOX_UNAVAILABLE');
      }
    },
    async remove(name) {
      try {
        await docker.getContainer(name).remove({ force: false, v: false });
      } catch (error) {
        if (!missing(error)) throw new SandboxError('SANDBOX_UNAVAILABLE');
      }
    },
  };
}
export function decodeLogs(buffer: Buffer): { output: string; truncated: boolean } {
  const pieces: Buffer[] = [];
  let offset = 0,
    bytes = 0;
  while (offset + 8 <= buffer.length && bytes < 65_536) {
    const length = buffer.readUInt32BE(offset + 4);
    if (
      ![1, 2].includes(buffer[offset]!) ||
      buffer[offset + 1] !== 0 ||
      length > buffer.length - offset - 8
    )
      break;
    const piece = buffer.subarray(offset + 8, offset + 8 + Math.min(length, 65_536 - bytes));
    pieces.push(piece);
    bytes += piece.length;
    offset += 8 + length;
  }
  return {
    output: Buffer.concat(pieces).toString('utf8').slice(0, 65_536),
    truncated: bytes >= 65_536 || offset < buffer.length,
  };
}
export async function waitContainer(
  engine: ContainerEngine,
  name: string,
  expiresAt: number,
  signal: AbortSignal,
): Promise<{ exitCode: number; timedOut: boolean }> {
  while (true) {
    const state = await engine.inspect(name);
    if (!state) throw new SandboxError('SANDBOX_UNCERTAIN');
    if (!state.State.Running && state.State.Status !== 'created')
      return { exitCode: state.State.ExitCode, timedOut: Date.now() >= expiresAt };
    if (signal.aborted || Date.now() >= expiresAt) {
      await engine.stop(name);
      return { exitCode: 137, timedOut: !signal.aborted || Date.now() >= expiresAt };
    }
    await delay(150);
  }
}
