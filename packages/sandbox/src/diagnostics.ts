import { statfs } from 'node:fs/promises';
import { totalmem, platform } from 'node:os';
import type { InfraConfig } from '@sazuz/config';
import { sandboxDiagnosticsSchema } from '@sazuz/core/sandbox';
import { issueGrant } from './auth.js';

export async function sandboxDiagnostics(
  config: InfraConfig,
  key: string,
  fetcher: typeof fetch = fetch,
) {
  async function probe(service: 'docker' | 'egress', endpoint: string, path: string) {
    try {
      const token = issueGrant(key, {
        service,
        subject: 'health',
        projectId: 'health',
        agentId: 'health',
        domains: [],
        expiresAt: Date.now() + 5000,
      });
      const response = await fetcher(new URL(path, endpoint), {
        headers: { 'x-sazuz-capability': token },
        signal: AbortSignal.timeout(2000),
        redirect: 'error',
      });
      const text = await response.text();
      return response.ok && (service === 'docker' ? text === 'OK' : text === '{"ready":true}')
        ? ('ready' as const)
        : ('unavailable' as const);
    } catch {
      return 'unavailable' as const;
    }
  }
  const [docker, egress, disk] = await Promise.all([
    probe('docker', config.dockerProxyUrl, '/_ping'),
    probe('egress', config.egressProxyUrl, '/health'),
    statfs(config.dataDir).then(
      (value) => Math.floor((value.bavail * value.bsize) / 1024 ** 2),
      () => null,
    ),
  ]);
  return sandboxDiagnosticsSchema.parse({
    docker,
    egress,
    browser: 'unavailable',
    platform: platform(),
    memoryMb: Math.floor(totalmem() / 1024 ** 2),
    freeDiskMb: disk,
    gpu: 'unknown',
    hint:
      docker === 'ready' && egress === 'ready'
        ? 'Sandbox proxies are reachable. Code runs still require the matching image and policy approval.'
        : 'Start the core Docker profile and build its sandbox images. Generated code is never run on this application host.',
  });
}
