import Docker from 'dockerode';
import { Duplex, PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { z } from 'zod';
import { type InfraConfig } from '@sazuz/config';
import { mcpTransportSchema, McpError } from '@sazuz/core/mcp';
import { SandboxError } from '@sazuz/core/sandbox';
import { digest, issueGrant, type ServiceGrant } from './auth.js';

export const mcpContainerNameSchema = z.string().regex(/^sazuz-mcp-[a-f0-9]{40}$/);
export const mcpContainerSchema = z.strictObject({
  Image: z
    .string()
    .max(300)
    .regex(/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/),
  User: z.literal('1000:1000'),
  WorkingDir: z.literal('/tmp'),
  Entrypoint: z.tuple([
    z
      .string()
      .max(256)
      .regex(/^\/[a-zA-Z0-9_./-]+$/),
  ]),
  Cmd: z
    .array(
      z
        .string()
        .max(1024)
        .refine((value) => [...value].every((char) => char.charCodeAt(0) >= 32)),
    )
    .max(32),
  Env: z.tuple([z.literal('HOME=/tmp'), z.literal('PATH=/usr/local/bin:/usr/bin:/bin')]),
  AttachStdin: z.literal(true),
  AttachStdout: z.literal(true),
  AttachStderr: z.literal(true),
  OpenStdin: z.literal(true),
  StdinOnce: z.literal(false),
  Tty: z.literal(false),
  Labels: z.strictObject({
    'sazuz.managed': z.literal('mcp'),
    'sazuz.project': z.string().regex(/^[a-z]+_[0-9A-HJKMNP-TV-Z]{26}$/),
    'sazuz.key': z.string().regex(/^[a-f0-9]{64}$/),
    'sazuz.expires': z.string().regex(/^\d{13}$/),
  }),
  HostConfig: z.strictObject({
    ReadonlyRootfs: z.literal(true),
    CapDrop: z.tuple([z.literal('ALL')]),
    SecurityOpt: z.tuple([z.literal('no-new-privileges:true')]),
    NetworkMode: z.literal('none'),
    Dns: z.tuple([z.literal('127.0.0.1')]),
    Memory: z.literal(536870912),
    MemorySwap: z.literal(536870912),
    NanoCpus: z.literal(1000000000),
    PidsLimit: z.literal(64),
    Init: z.literal(true),
    AutoRemove: z.literal(false),
    Runtime: z.literal('runc'),
    Tmpfs: z.strictObject({ '/tmp': z.literal('rw,noexec,nosuid,nodev,size=64m,mode=1777') }),
    Mounts: z.array(z.never()).length(0),
    LogConfig: z.strictObject({ Type: z.literal('none'), Config: z.strictObject({}) }),
    RestartPolicy: z.strictObject({ Name: z.literal('no'), MaximumRetryCount: z.literal(0) }),
  }),
});
export type McpContainer = z.infer<typeof mcpContainerSchema>;
export function buildMcpContainer(input: {
  transport: unknown;
  projectId: string;
  expiresAt: number;
  key: string;
}): McpContainer {
  const transport = mcpTransportSchema.parse(input.transport);
  if (transport.kind !== 'stdio') throw new SandboxError('SANDBOX_INVALID');
  return mcpContainerSchema.parse({
    Image: transport.image,
    User: '1000:1000',
    WorkingDir: '/tmp',
    Entrypoint: [transport.command],
    Cmd: transport.args,
    Env: ['HOME=/tmp', 'PATH=/usr/local/bin:/usr/bin:/bin'],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: true,
    StdinOnce: false,
    Tty: false,
    Labels: {
      'sazuz.managed': 'mcp',
      'sazuz.project': input.projectId,
      'sazuz.key': digest(input.key),
      'sazuz.expires': String(input.expiresAt),
    },
    HostConfig: {
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      NetworkMode: 'none',
      Dns: ['127.0.0.1'],
      Memory: 536870912,
      MemorySwap: 536870912,
      NanoCpus: 1000000000,
      PidsLimit: 64,
      Init: true,
      AutoRemove: false,
      Runtime: 'runc',
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=64m,mode=1777' },
      Mounts: [],
      LogConfig: { Type: 'none', Config: {} },
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
    },
  });
}
export function validateMcpContainer(
  value: unknown,
  name: string,
  grant: ServiceGrant,
  now = Date.now(),
) {
  const result = mcpContainerSchema.safeParse(value);
  if (!result.success || !mcpContainerNameSchema.safeParse(name).success)
    throw new SandboxError('SANDBOX_DENIED');
  const spec = result.data;
  if (
    grant.subject !== name ||
    grant.specHash !== digest(JSON.stringify(spec)) ||
    grant.projectId !== spec.Labels['sazuz.project'] ||
    name !== `sazuz-mcp-${spec.Labels['sazuz.key'].slice(0, 40)}` ||
    Number(spec.Labels['sazuz.expires']) <= now ||
    Number(spec.Labels['sazuz.expires']) > Math.min(grant.expiresAt, now + 60_000) ||
    spec.Entrypoint[0].split('/').includes('..') ||
    grant.domains.length
  )
    throw new SandboxError('SANDBOX_DENIED');
  return spec;
}

/** Send an empty upgrade request; Dockerode's stdin attach sends a chunked body. */
async function attach(url: URL, name: string, token: string, signal: AbortSignal): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      new URL(`/v1.47/containers/${name}/attach?stream=1&stdin=1&stdout=1&stderr=1`, url),
      {
        method: 'POST',
        headers: {
          'x-sazuz-capability': token,
          connection: 'Upgrade',
          upgrade: 'tcp',
          'content-length': '0',
        },
        signal,
        timeout: 10_000,
      },
    );
    request.once('timeout', () => request.destroy(new McpError('MCP_UNAVAILABLE')));
    request.once('error', () => reject(new McpError('MCP_UNAVAILABLE')));
    request.once('response', (response) => {
      response.destroy();
      request.destroy();
      reject(new McpError('MCP_UNAVAILABLE'));
    });
    request.once('upgrade', (_response, socket, head) => {
      request.setTimeout(0);
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    request.end();
  });
}

/** No host process, Docker socket, application directory or credential is given to the server. */
export function createMcpProcess(options: {
  config: Pick<InfraConfig, 'dockerProxyUrl'>;
  key: string;
  transport: unknown;
  projectId: string;
  agentId: string;
  signal: AbortSignal;
  onData(data: Buffer): void;
  onError(): void;
  onClose(): void;
}) {
  const key = randomUUID(),
    expiresAt = Date.now() + 45_000;
  const spec = buildMcpContainer({
    transport: options.transport,
    projectId: options.projectId,
    key,
    expiresAt,
  });
  const name = `sazuz-mcp-${digest(key).slice(0, 40)}`;
  const token = issueGrant(options.key, {
    service: 'docker',
    subject: name,
    projectId: options.projectId,
    agentId: options.agentId,
    domains: [],
    expiresAt: expiresAt + 15000,
    specHash: digest(JSON.stringify(spec)),
  });
  const url = new URL(options.config.dockerProxyUrl);
  const docker = new Docker({
    host: url.hostname,
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    protocol: url.protocol === 'https:' ? 'https' : 'http',
    version: 'v1.47',
    headers: { 'x-sazuz-capability': token },
    timeout: 10_000,
  });
  const container = docker.getContainer(name);
  let stream: Duplex | undefined,
    created = false,
    closed = false;
  const stdout = new PassThrough(),
    stderr = new PassThrough();
  let bytes = 0;
  for (const pipe of [stdout, stderr])
    pipe.on('data', (data: Buffer) => {
      bytes += data.length;
      if (bytes > 524_288) {
        options.onError();
        stream?.destroy();
        return;
      }
      if (pipe === stdout) options.onData(data);
    });
  async function close() {
    if (closed) return;
    closed = true;
    options.signal.removeEventListener('abort', abort);
    stream?.destroy();
    stdout.destroy();
    stderr.destroy();
    if (created) {
      try {
        await container.kill();
      } catch {
        options.onError();
      }
      try {
        await container.remove({ force: false, v: false });
      } catch {
        options.onError();
      }
    }
    options.onClose();
  }
  const abort = () => {
    void close().catch(() => options.onError());
  };
  return {
    async start() {
      if (closed || options.signal.aborted) throw new McpError('MCP_DENIED');
      try {
        const createOptions = { ...spec, _query: { name }, _body: spec };
        await docker.createContainer(createOptions);
        created = true;
        options.signal.addEventListener('abort', abort, { once: true });
        if (options.signal.aborted) {
          await close();
          throw new McpError('MCP_DENIED');
        }
        const connection = await attach(url, name, token, options.signal);
        if (!(connection instanceof Duplex)) throw new McpError('MCP_UNAVAILABLE');
        stream = connection;
        if (closed || options.signal.aborted) {
          stream.destroy();
          throw new McpError('MCP_DENIED');
        }
        stream.on('error', () => options.onError());
        stream.once('close', () => options.onClose());
        docker.modem.demuxStream(stream, stdout, stderr);
        await container.start();
        if (options.signal.aborted) {
          await close();
          throw new McpError('MCP_DENIED');
        }
      } catch {
        await close();
        throw new McpError('MCP_UNAVAILABLE');
      }
    },
    async write(value: string) {
      if (closed || !stream || options.signal.aborted || Buffer.byteLength(value) > 131_072)
        throw new McpError('MCP_DENIED');
      const socket = stream;
      await new Promise<void>((resolve, reject) =>
        socket.write(value, (error) =>
          error ? reject(new McpError('MCP_UNAVAILABLE')) : resolve(),
        ),
      );
    },
    close,
  };
}
