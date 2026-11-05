import { z } from 'zod';
import type { SettingsDocument } from '@sazuz/config/settings';
import type { InfraConfig } from '@sazuz/config';
import { SandboxError, type SandboxInput } from '@sazuz/core/sandbox';
import { digest, type ServiceGrant } from './auth.js';

export const containerNameSchema = z.string().regex(/^sazuz-code-[a-f0-9]{40}$/);
const id = z.string().regex(/^[a-z]+_[0-9A-HJKMNP-TV-Z]{26}$/);
export const containerSpecSchema = z.strictObject({
  Image: z.enum(['sazuz/sandbox-python:phase5', 'sazuz/sandbox-node:phase5']),
  User: z.literal('1000:1000'),
  WorkingDir: z.literal('/workspace'),
  Entrypoint: z.tuple([
    z.enum(['python', 'node']),
    z.enum(['/opt/sazuz/runner.py', '/opt/sazuz/runner.mjs']),
  ]),
  Cmd: z.tuple([
    z
      .string()
      .min(1)
      .max(65_536)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    z.string().regex(/^\d{1,7}$/),
  ]),
  Env: z.array(z.string().max(20_000)).max(12),
  AttachStdout: z.literal(true),
  AttachStderr: z.literal(true),
  Tty: z.literal(false),
  OpenStdin: z.literal(false),
  Labels: z.strictObject({
    'sazuz.managed': z.literal('code'),
    'sazuz.project': id,
    'sazuz.run': id,
    'sazuz.key': z.string().regex(/^[a-f0-9]{64}$/),
    'sazuz.expires': z.string().regex(/^\d{13}$/),
  }),
  HostConfig: z.strictObject({
    ReadonlyRootfs: z.literal(true),
    CapDrop: z.tuple([z.literal('ALL')]),
    SecurityOpt: z.tuple([z.literal('no-new-privileges:true')]),
    NetworkMode: z.literal('none'),
    Dns: z.tuple([z.literal('127.0.0.1')]),
    Memory: z
      .number()
      .int()
      .min(128 * 1024 ** 2)
      .max(32768 * 1024 ** 2),
    MemorySwap: z.number().int().positive(),
    NanoCpus: z.number().int().min(250_000_000).max(16_000_000_000),
    PidsLimit: z.number().int().min(16).max(256),
    Init: z.literal(true),
    AutoRemove: z.literal(false),
    Runtime: z.enum(['runc', 'runsc']),
    Tmpfs: z.strictObject({ '/tmp': z.literal('rw,noexec,nosuid,nodev,size=128m,mode=1777') }),
    Mounts: z.tuple([
      z.strictObject({
        Type: z.literal('volume'),
        Source: z.string().min(1).max(128),
        Target: z.literal('/workspace'),
        ReadOnly: z.literal(false),
        VolumeOptions: z.strictObject({
          NoCopy: z.literal(true),
          Subpath: id,
          Labels: z.strictObject({}),
          DriverConfig: z.strictObject({ Name: z.literal('local'), Options: z.strictObject({}) }),
        }),
      }),
      z
        .strictObject({
          Type: z.literal('volume'),
          Source: z.string().min(1).max(128),
          Target: z.literal('/run/sazuz-egress'),
          ReadOnly: z.literal(true),
          VolumeOptions: z.strictObject({
            NoCopy: z.literal(true),
            Labels: z.strictObject({}),
            DriverConfig: z.strictObject({ Name: z.literal('local'), Options: z.strictObject({}) }),
          }),
        })
        .optional(),
    ]),
    LogConfig: z.strictObject({
      Type: z.literal('json-file'),
      Config: z.strictObject({ 'max-size': z.literal('1m'), 'max-file': z.literal('1') }),
    }),
    RestartPolicy: z.strictObject({ Name: z.literal('no'), MaximumRetryCount: z.literal(0) }),
  }),
});
export type ContainerSpec = z.infer<typeof containerSpecSchema>;
export const containerName = (key: string) => `sazuz-code-${digest(key).slice(0, 40)}`;
export function buildContainer(input: {
  args: SandboxInput;
  projectId: string;
  runId: string;
  key: string;
  expiresAt: number;
  settings: SettingsDocument['sandbox']['value'];
  config: InfraConfig;
  proxyToken?: string;
}): ContainerSpec {
  const { args, settings, config } = input;
  const python = args.language === 'python';
  const env = [
    'HOME=/tmp',
    'PYTHONDONTWRITEBYTECODE=1',
    'PYTHONUNBUFFERED=1',
    'MPLCONFIGDIR=/tmp/mpl',
    'NODE_USE_ENV_PROXY=1',
  ];
  if (args.network === 'allowlist') {
    if (!input.proxyToken) throw new SandboxError('SANDBOX_DENIED');
    const proxy = new URL('http://127.0.0.1:18888');
    proxy.username = 'sazuz';
    proxy.password = input.proxyToken;
    env.push(
      `HTTP_PROXY=${proxy.href}`,
      `HTTPS_PROXY=${proxy.href}`,
      `http_proxy=${proxy.href}`,
      `https_proxy=${proxy.href}`,
      'NO_PROXY=',
      'no_proxy=',
    );
  }
  return containerSpecSchema.parse({
    Image: python ? 'sazuz/sandbox-python:phase5' : 'sazuz/sandbox-node:phase5',
    User: '1000:1000',
    WorkingDir: '/workspace',
    Entrypoint: [
      python ? 'python' : 'node',
      python ? '/opt/sazuz/runner.py' : '/opt/sazuz/runner.mjs',
    ],
    Cmd: [
      Buffer.from(args.code).toString('base64'),
      String(Math.max(1, input.expiresAt - Date.now())),
    ],
    Env: env,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    OpenStdin: false,
    Labels: {
      'sazuz.managed': 'code',
      'sazuz.project': input.projectId,
      'sazuz.run': input.runId,
      'sazuz.key': digest(input.key),
      'sazuz.expires': String(input.expiresAt),
    },
    HostConfig: {
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      NetworkMode: 'none',
      Dns: ['127.0.0.1'],
      Memory: settings.memoryMb * 1024 ** 2,
      MemorySwap: settings.memoryMb * 1024 ** 2,
      NanoCpus: Math.round(settings.cpu * 1_000_000_000),
      PidsLimit: settings.pids,
      Init: true,
      AutoRemove: false,
      Runtime: settings.runtime,
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=128m,mode=1777' },
      Mounts: [
        {
          Type: 'volume',
          Source: config.workspaceVolume,
          Target: '/workspace',
          ReadOnly: false,
          VolumeOptions: {
            NoCopy: true,
            Subpath: input.projectId,
            Labels: {},
            DriverConfig: { Name: 'local', Options: {} },
          },
        },
        ...(args.network === 'allowlist'
          ? [
              {
                Type: 'volume',
                Source: config.egressSocketVolume,
                Target: '/run/sazuz-egress',
                ReadOnly: true,
                VolumeOptions: {
                  NoCopy: true,
                  Labels: {},
                  DriverConfig: { Name: 'local', Options: {} },
                },
              },
            ]
          : []),
      ],
      LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } },
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
    },
  });
}
export function validateContainer(
  value: unknown,
  name: string,
  grant: ServiceGrant,
  config: InfraConfig,
  now = Date.now(),
): ContainerSpec {
  const parsed = containerSpecSchema.safeParse(value);
  if (!parsed.success || !containerNameSchema.safeParse(name).success)
    throw new SandboxError('SANDBOX_DENIED');
  const spec = parsed.data;
  const expires = Number(spec.Labels['sazuz.expires']);
  const python = spec.Image === 'sazuz/sandbox-python:phase5';
  const socket = spec.HostConfig.Mounts[1];
  const baseEnv = [
    'HOME=/tmp',
    'PYTHONDONTWRITEBYTECODE=1',
    'PYTHONUNBUFFERED=1',
    'MPLCONFIGDIR=/tmp/mpl',
    'NODE_USE_ENV_PROXY=1',
  ];
  if (
    grant.subject !== name ||
    grant.projectId !== spec.Labels['sazuz.project'] ||
    name !== `sazuz-code-${spec.Labels['sazuz.key'].slice(0, 40)}` ||
    expires <= now ||
    expires > Math.min(now + 3_600_000, grant.expiresAt) ||
    Number(spec.Cmd[1]) > 3_600_000 ||
    Number(spec.Cmd[1]) < 1 ||
    spec.HostConfig.MemorySwap !== spec.HostConfig.Memory ||
    spec.Entrypoint[0] !== (python ? 'python' : 'node') ||
    spec.Entrypoint[1] !== (python ? '/opt/sazuz/runner.py' : '/opt/sazuz/runner.mjs') ||
    spec.HostConfig.Mounts[0].Source !== config.workspaceVolume ||
    spec.HostConfig.Mounts[0].VolumeOptions.Subpath !== grant.projectId ||
    (socket && socket.Source !== config.egressSocketVolume) ||
    baseEnv.some((item, index) => spec.Env[index] !== item)
  )
    throw new SandboxError('SANDBOX_DENIED');
  if (!socket && spec.Env.length !== baseEnv.length) throw new SandboxError('SANDBOX_DENIED');
  if (socket) {
    if (
      !grant.domains.length ||
      spec.Env.length !== 11 ||
      spec.Env[9] !== 'NO_PROXY=' ||
      spec.Env[10] !== 'no_proxy='
    )
      throw new SandboxError('SANDBOX_DENIED');
    const expected = ['HTTP_PROXY=', 'HTTPS_PROXY=', 'http_proxy=', 'https_proxy='];
    for (let index = 0; index < expected.length; index++) {
      const item = spec.Env[index + 5]!;
      if (!item.startsWith(expected[index]!)) throw new SandboxError('SANDBOX_DENIED');
      if (item.slice(expected[index]!.length) !== spec.Env[5]!.slice(expected[0]!.length))
        throw new SandboxError('SANDBOX_DENIED');
      let url: URL;
      try {
        url = new URL(item.slice(expected[index]!.length));
      } catch {
        throw new SandboxError('SANDBOX_DENIED');
      }
      if (
        url.origin !== 'http://127.0.0.1:18888' ||
        url.username !== 'sazuz' ||
        !url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      )
        throw new SandboxError('SANDBOX_DENIED');
    }
  }
  return spec;
}
