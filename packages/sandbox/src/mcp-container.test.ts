import { describe, expect, it } from 'vitest';
import { buildMcpContainer, validateMcpContainer } from './mcp-container.js';
import { digest, type ServiceGrant } from './auth.js';

describe('MCP stdio container admission', () => {
  function fixture() {
    const now = Date.now(),
      key = 'mcp-container-test',
      projectId = 'prj_01K00000000000000000000000';
    const spec = buildMcpContainer({
      key,
      projectId,
      expiresAt: now + 45000,
      transport: {
        kind: 'stdio',
        image: 'example/mcp@sha256:' + 'a'.repeat(64),
        command: '/usr/local/bin/node',
        args: ['/app/server.mjs'],
      },
    });
    const name = `sazuz-mcp-${digest(key).slice(0, 40)}`;
    const grant: ServiceGrant = {
      service: 'docker',
      subject: name,
      projectId,
      agentId: 'operator',
      domains: [],
      expiresAt: now + 60000,
      nonce: '4018e587-d7ca-4d64-9f92-241182f1ffca',
      specHash: digest(JSON.stringify(spec)),
    };
    return { spec, name, grant, now };
  }
  it('admits only the signed, non-root, networkless, mount-free spec', () => {
    const { spec, name, grant, now } = fixture();
    expect(validateMcpContainer(spec, name, grant, now)).toEqual(spec);
    expect(spec.HostConfig.Mounts).toEqual([]);
    expect(spec.HostConfig.NetworkMode).toBe('none');
  });
  it.each(['Privileged', 'Binds', 'Devices', 'ExtraHosts'])(
    'rejects additional Docker authority %s',
    (key) => {
      const { spec, name, grant } = fixture();
      expect(() =>
        validateMcpContainer(
          { ...spec, HostConfig: { ...spec.HostConfig, [key]: true } },
          name,
          grant,
        ),
      ).toThrow();
    },
  );
  it('rejects image/command/network/credential substitution, absent signatures and expiry', () => {
    const { spec, name, grant, now } = fixture();
    for (const changed of [
      { ...spec, Image: 'example/mcp:latest' },
      { ...spec, Cmd: ['/other.mjs'] },
      { ...spec, User: '0:0' },
      { ...spec, Env: [...spec.Env, 'TOKEN=plaintext'] },
      { ...spec, HostConfig: { ...spec.HostConfig, NetworkMode: 'host' } },
    ])
      expect(() => validateMcpContainer(changed, name, grant, now)).toThrow();
    expect(() =>
      validateMcpContainer(spec, name, { ...grant, specHash: 'b'.repeat(64) }, now),
    ).toThrow();
    expect(() => validateMcpContainer(spec, name, grant, now + 60000)).toThrow();
  });
});
