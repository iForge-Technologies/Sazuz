import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import { z } from 'zod';
import { readInfraConfig, readOperatorKey } from '@sazuz/config';
import { createLogger } from '@sazuz/core';
import { createDatabase } from '@sazuz/db';
import { createEgressProxy } from '@sazuz/sandbox';
import { secretRedactor } from '@sazuz/vault';
import { createBrowserApp } from '../../apps/browser/src/app.js';
import { resolvePublicUrl } from '../../packages/tools/src/network.js';
import { phaseNineBrowserFixture } from './phase-nine-browser.js';

export const phaseFiveFormCanary = 'phase5-production-form-canary-925174';

/** Test-only host Chromium with a disposable HTTPS site. Never enabled by application settings. */
async function start() {
  const channel = z
    .enum(['chromium', 'chrome', 'msedge'])
    .default(process.platform === 'win32' ? 'msedge' : 'chromium')
    .parse(process.env.PLAYWRIGHT_CHANNEL);
  const config = readInfraConfig();
  if (!config.databaseUrl || !new URL(config.databaseUrl).pathname.endsWith('_test'))
    throw new Error('The browser fixture requires a dedicated test database.');
  const endpoint = new URL(config.browserUrl);
  if (endpoint.hostname !== '127.0.0.1' || !endpoint.port)
    throw new Error('The browser fixture must bind loopback.');
  const directory = await mkdtemp(join(tmpdir(), 'sazuz-phase5-site-'));
  const keyPath = join(directory, 'key.pem'),
    certPath = join(directory, 'cert.pem');
  await promisify(execFile)(
    process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=fixture.example',
      '-addext',
      'subjectAltName=DNS:fixture.example',
    ],
    { windowsHide: true },
  );
  let submissions = 0,
    loginReceived = false,
    detailsReceived = false;
  const learning = phaseNineBrowserFixture();
  const site = createServer(
    { key: await readFile(keyPath), cert: await readFile(certPath) },
    (request, response) => {
      void (async () => {
        let body = '';
        for await (const part of request) {
          body += String(part);
          if (body.length > 16384) throw new Error('Oversized fixture form.');
        }
        const path = new URL(request.url ?? '/', 'https://fixture.example').pathname;
        const fields = new URLSearchParams(body);
        response.setHeader('content-type', 'text/html; charset=utf-8');
        const page = (title: string, content: string) =>
          `<!doctype html><html><head><title>${title}</title><style>body{font:20px system-ui;padding:40px}input,select,button{font:inherit;padding:8px;margin:8px}label{display:block}</style></head><body><h1>${title}</h1>${content}</body></html>`;
        const learned = learning.render(path, request.method, fields);
        if (learned !== undefined) response.end(page('Demo project', learned));
        else if (path === '/login' && request.method === 'POST') {
          loginReceived = fields.get('password') === phaseFiveFormCanary;
          response
            .writeHead(303, {
              location: '/details',
              'set-cookie': `fixture=${phaseFiveFormCanary}; Secure; HttpOnly; SameSite=Strict; Path=/`,
            })
            .end();
        } else if (path === '/login')
          response.end(
            page(
              'Sign in',
              '<form method="post"><label>Username<input autofocus name="username" autocomplete="username"></label><label>Password<input type="password" name="password" autocomplete="current-password"></label><button>Sign in</button></form>',
            ),
          );
        else if (path === '/details')
          response.end(
            page(
              'Project details',
              `<p>Private echo: ${phaseFiveFormCanary}</p><form method="post" action="/review"><label>Project name<input name="project"></label><label>Region<select name="region"><option>East</option><option>West</option></select></label><button>Review</button></form><p style="margin-top:1400px">Scroll target</p>`,
            ),
          );
        else if (path === '/review') {
          detailsReceived =
            fields.get('project') === 'Launch project' && fields.get('region') === 'West';
          response.end(
            page(
              'Review project',
              '<form method="post" action="/submitted"><button>Submit project</button></form>',
            ),
          );
        } else if (path === '/submitted') {
          if (request.method === 'POST') submissions++;
          response.end(page('Project submitted', '<p>Confirmation: fixture-42.</p>'));
        } else response.end(page('Start project', '<a href="/login">Start</a>'));
      })().catch(() => {
        response.writeHead(500).end('Fixture failure.');
      });
    },
  );
  await new Promise<void>((accept) => site.listen(0, '127.0.0.1', accept));
  const key = await readOperatorKey(config.dataDir);
  const proxy = createEgressProxy({
    key,
    resolve: (url, dependencies) =>
      resolvePublicUrl(url, {
        ...dependencies,
        lookup: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      }),
    dial: () => connect({ host: '127.0.0.1', port: (site.address() as AddressInfo).port }),
  });
  await new Promise<void>((accept) => proxy.server.listen(0, '127.0.0.1', accept));
  const database = await createDatabase(
    config,
    createLogger('phase5-site-fixture', secretRedactor),
    { maxConnections: 16 },
  );
  const service = await createBrowserApp({
    database,
    key,
    egressUrl: `http://127.0.0.1:${(proxy.server.address() as AddressInfo).port}`,
    ignoreHTTPSErrors: true,
    launch: () =>
      chromium.launch({
        headless: true,
        chromiumSandbox: true,
        channel,
      }),
  });
  service.app.get('/fixture/status', async () => {
    const session = [...service.engine.sessions.values()].at(-1);
    const page = session?.pages.get(session.activeTab);
    let scrollY = 0;
    try {
      scrollY = page ? await page.evaluate(() => window.scrollY) : 0;
    } catch {
      /* A page may close while the test polls its non-sensitive state. */
    }
    return { submissions, loginReceived, detailsReceived, scrollY };
  });
  service.app.get('/fixture/learning', async () => {
    const session = [...service.engine.sessions.values()].at(-1);
    const page = session?.pages.get(session.activeTab);
    let fields: { focus: string; lengths: Record<string, number>; confirmed: boolean } = {
      focus: '',
      lengths: {},
      confirmed: false,
    };
    if (page && !page.isClosed()) {
      try {
        fields = await page.evaluate(() => ({
          focus: document.activeElement?.id ?? '',
          lengths: Object.fromEntries(
            ['project', 'client', 'category', 'notes'].map((id) => [
              id,
              (document.getElementById(id) as HTMLInputElement | null)?.value.length ?? 0,
            ]),
          ),
          confirmed:
            (document.getElementById('confirmed') as HTMLInputElement | null)?.checked ?? false,
        }));
      } catch (error) {
        const navigating =
          error instanceof Error && error.message.includes('Execution context was destroyed');
        if (!page.isClosed() && !navigating) throw error;
        // A navigation or completed run may replace/close the page during this test-only poll.
      }
    }
    return {
      path: page ? new URL(page.url()).pathname : '',
      submissions: learning.submissions,
      ...fields,
    };
  });
  service.app.post('/fixture/learning/change', () => {
    learning.change();
    return Promise.resolve({ ok: true });
  });
  await service.app.listen({ host: '127.0.0.1', port: Number(endpoint.port) });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await service.app.close();
    await proxy.close();
    site.closeAllConnections();
    await new Promise<void>((accept) => site.close(() => accept()));
    await database.close();
    if (
      resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
      directory.includes('sazuz-phase5-site-')
    )
      await rm(directory, { recursive: true, force: true });
  };
  for (const event of ['SIGINT', 'SIGTERM'] as const)
    process.once(event, () => {
      void close().catch(() => {
        process.stderr.write('Browser fixture cleanup failed.\n');
        process.exitCode = 1;
      });
    });
  process.stdout.write('Phase 5 test browser and disposable HTTPS site ready.\n');
}
if (process.argv[2] === '--run') {
  try {
    await start();
  } catch {
    process.stderr.write('The test-only browser fixture could not start.\n');
    process.exitCode = 1;
  }
}
