import { describe, expect, it } from 'vitest';
import { freshSettings } from '@sazuz/config/settings';
import { readInfraConfig } from '@sazuz/config';
import { sandboxInputSchema } from '@sazuz/core/sandbox';
import { issueGrant, verifyGrant } from './auth.js';
import { buildContainer, containerName, validateContainer } from './container.js';
import { decodeLogs, waitContainer, type ContainerEngine } from './docker.js';

const key = Buffer.alloc(32, 7).toString('base64url');
const config = readInfraConfig({});
const projectId = 'prj_01K00000000000000000000000';
const runId = 'run_01K00000000000000000000000';
const callKey = `${runId}:1:0`;
function fixture(network: 'none' | 'allowlist' = 'none') {
  const name = containerName(callKey),
    expiresAt = Date.now() + 60_000;
  const common = {
    subject: name,
    projectId,
    agentId: 'analyst',
    domains: network === 'none' ? [] : ['example.com'],
    expiresAt,
  };
  const token = issueGrant(key, { ...common, service: 'docker' });
  const spec = buildContainer({
    args: sandboxInputSchema.parse({ language: 'python', code: 'print(42)', network }),
    projectId,
    runId,
    key: callKey,
    expiresAt,
    settings: freshSettings().sandbox.value,
    config,
    ...(network === 'allowlist'
      ? { proxyToken: issueGrant(key, { ...common, service: 'egress' }) }
      : {}),
  });
  return { name, spec, grant: verifyGrant(key, 'docker', token), token };
}
describe('sandbox execution and Docker boundary', () => {
  it('uses network none, a confined volume, non-root and bounded read-only execution', () => {
    const { spec, name, grant } = fixture();
    expect(validateContainer(spec, name, grant, config)).toEqual(spec);
    expect(spec.HostConfig).toMatchObject({
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      Dns: ['127.0.0.1'],
      MemorySwap: spec.HostConfig.Memory,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
    });
    expect(spec.HostConfig.Mounts[0].VolumeOptions.Subpath).toBe(projectId);
    expect(spec.User).toBe('1000:1000');
  });
  it.each([
    [
      'privileged',
      (s: Record<string, unknown>) => {
        Object.assign(s['HostConfig'] as object, { Privileged: true });
      },
    ],
    [
      'host network',
      (s: Record<string, unknown>) => {
        Object.assign(s['HostConfig'] as object, { NetworkMode: 'host' });
      },
    ],
    [
      'bind mount',
      (s: Record<string, unknown>) => {
        Object.assign(s['HostConfig'] as object, { Binds: ['/:/host'] });
      },
    ],
    [
      'unconfined seccomp',
      (s: Record<string, unknown>) => {
        Object.assign(s['HostConfig'] as object, { SecurityOpt: ['seccomp=unconfined'] });
      },
    ],
    [
      'other image',
      (s: Record<string, unknown>) => {
        s['Image'] = 'alpine:latest';
      },
    ],
    [
      'root user',
      (s: Record<string, unknown>) => {
        s['User'] = '0';
      },
    ],
    [
      'arbitrary entrypoint',
      (s: Record<string, unknown>) => {
        s['Entrypoint'] = ['/bin/sh'];
      },
    ],
    [
      'extra env',
      (s: Record<string, unknown>) => {
        s['Env'] = ['LD_PRELOAD=/workspace/evil.so'];
      },
    ],
  ])('rejects %s before contacting Docker', (_label, mutate) => {
    const { spec, name, grant } = fixture();
    const altered: Record<string, unknown> = structuredClone(spec);
    mutate(altered);
    expect(() => validateContainer(altered, name, grant, config)).toThrow();
  });
  it('binds each capability to a purpose, expiry, container and project', () => {
    const { spec, name, grant, token } = fixture();
    expect(() => verifyGrant(key, 'egress', token)).toThrow();
    expect(() => verifyGrant(key, 'docker', token, grant.expiresAt)).toThrow();
    expect(() => verifyGrant(key, 'docker', `${token.slice(0, -8)}12345678`)).toThrow();
    expect(() =>
      validateContainer(spec, name, { ...grant, projectId: 'another-project' }, config),
    ).toThrow();
    expect(() => validateContainer(spec, `${name}a`, grant, config)).toThrow();
  });
  it('keeps network none and admits only the fixed read-only proxy socket', () => {
    const { spec, name, grant } = fixture('allowlist');
    expect(validateContainer(spec, name, grant, config).HostConfig.NetworkMode).toBe('none');
    expect(spec.HostConfig.Mounts[1]).toMatchObject({
      Source: config.egressSocketVolume,
      Target: '/run/sazuz-egress',
      ReadOnly: true,
    });
    const forged = structuredClone(spec);
    forged.HostConfig.Mounts[1]!.Source = 'another-volume';
    expect(() => validateContainer(forged, name, grant, config)).toThrow();
    spec.Env[5] = 'HTTP_PROXY=http://attacker.example';
    expect(() => validateContainer(spec, name, grant, config)).toThrow();
  });
  it('bounds multiplexed output and stops a running container at its deadline', async () => {
    const body = Buffer.alloc(100_000, 'a'),
      header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(body.length, 4);
    expect(decodeLogs(Buffer.concat([header, body]))).toEqual({
      output: 'a'.repeat(65_536),
      truncated: true,
    });
    let stopped = false;
    const engine: ContainerEngine = {
      inspect: () =>
        Promise.resolve({
          Name: '/test',
          Config: { Labels: {} },
          State: { Running: true, ExitCode: 0, Status: 'running' },
        }),
      create: () => Promise.resolve(),
      start: () => Promise.resolve(),
      stop: () => {
        stopped = true;
        return Promise.resolve();
      },
      logs: () => Promise.resolve(Buffer.alloc(0)),
      remove: () => Promise.resolve(),
    };
    expect(
      await waitContainer(engine, 'test', Date.now() - 1, new AbortController().signal),
    ).toEqual({ exitCode: 137, timedOut: true });
    expect(stopped).toBe(true);
  });
});
