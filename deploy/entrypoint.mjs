import { fileURLToPath } from 'node:url';

import { z } from 'zod';

const roleSchema = z.enum([
  'bootstrap',
  'migrate',
  'server',
  'worker',
  'web',
  'docker-proxy',
  'egress-proxy',
]);
const role = roleSchema.safeParse(process.argv[2]);

if (!role.success || process.argv.length !== 3) {
  process.stderr.write('Choose one Sazuz role: bootstrap, migrate, server, worker, or web.\n');
  process.exit(64);
}

const modules = {
  bootstrap: '../dist/bootstrap.js',
  migrate: '../dist/migrate.js',
  server: '../apps/server/dist/index.js',
  worker: '../apps/worker/dist/index.js',
  web: '../web/apps/web/server.js',
  'docker-proxy': '../dist/sandbox-proxy.js',
  'egress-proxy': '../dist/sandbox-proxy.js',
};

if (role.data === 'web') {
  // These are container-internal bindings; Compose publishes only localhost.
  process.env.HOSTNAME = '0.0.0.0';
  process.env.PORT = '7777';
}

const moduleUrl = new URL(modules[role.data], import.meta.url);
process.argv = [process.execPath, fileURLToPath(moduleUrl)];
if (role.data === 'docker-proxy') process.argv.push('docker');
if (role.data === 'egress-proxy') process.argv.push('egress');

try {
  if (role.data === 'web') {
    const { startWebLiveGateway } = await import(
      new URL('../dist/web-live-gateway.js', import.meta.url).href
    );
    await startWebLiveGateway();
  }
  await import(moduleUrl.href);
} catch {
  // Import/startup errors can contain connection strings. The roles report safe
  // typed diagnostics themselves; never echo an arbitrary exception here.
  process.stderr.write('The Sazuz role could not start. Check the preceding application logs.\n');
  process.exit(1);
}
