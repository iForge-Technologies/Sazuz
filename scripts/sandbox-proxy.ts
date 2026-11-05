import { readInfraConfig, readOperatorKey } from '@sazuz/config';
import { createLogger } from '@sazuz/core';
import { secretRedactor } from '@sazuz/vault';
import { createDockerSocketProxy, createEgressProxy } from '@sazuz/sandbox';
import { chmod, lstat, unlink } from 'node:fs/promises';

const logger = createLogger('sandbox-proxy', secretRedactor);
let cleanup: (() => Promise<void>) | undefined;
try {
  const config = readInfraConfig();
  const key = await readOperatorKey(config.dataDir);
  const docker = process.argv[2] === 'docker';
  if (!docker && process.argv[2] !== 'egress') throw new Error('Invalid proxy role.');
  const proxy = docker
    ? createDockerSocketProxy({
        key,
        config,
        onError: (code) => logger.error({ code }, 'Container deadline reconciliation will retry.'),
      })
    : createEgressProxy({ key });
  const local = docker ? undefined : createEgressProxy({ key });
  cleanup = async () => {
    await Promise.all([proxy.close(), local?.close()]);
  };
  if (local) {
    const socket = '/run/sazuz-egress/proxy.sock';
    const previous = await lstat(socket).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    });
    if (previous) {
      if (!previous.isSocket()) throw new Error('Invalid egress socket path.');
      await unlink(socket);
    }
    await new Promise<void>((resolve, reject) => {
      local.server.once('error', reject);
      local.server.listen(socket, resolve);
    });
    await chmod(socket, 0o600);
  }
  await new Promise<void>((resolve, reject) => {
    proxy.server.once('error', reject);
    proxy.server.listen(docker ? 2375 : 8080, '0.0.0.0', resolve);
  });
  logger.info(
    { event: 'proxy.ready', service: docker ? 'docker' : 'egress' },
    'Sandbox proxy is listening.',
  );
  const close = () => {
    void Promise.all([proxy.close(), local?.close()]).catch(() => {
      logger.error({ code: 'PROXY_CLOSE_FAILED' }, 'Proxy shutdown failed.');
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
} catch {
  await cleanup?.().catch(() =>
    logger.error({ code: 'PROXY_CLOSE_FAILED' }, 'Proxy startup cleanup failed.'),
  );
  logger.error({ code: 'PROXY_START_FAILED' }, 'The sandbox proxy could not start.');
  process.exitCode = 1;
}
