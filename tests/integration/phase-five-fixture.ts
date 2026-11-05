import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { connect, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { createBrowserClient } from '@sazuz/browser';
import { createEgressProxy } from '@sazuz/sandbox';
import { resolvePublicUrl } from '../../packages/tools/src/network.js';
import { createBrowserApp } from '../../apps/browser/src/app.js';
import {
  createBrowserGateway,
  type BrowserGateway,
} from '../../apps/server/src/phase-five-execution.js';
import { registerPhaseFive } from '../../apps/server/src/phase-five.js';
import { phaseFourFixture } from './phase-four-fixture.js';
import {
  createMission,
  recordHeartbeat,
  runs,
  saveSetting,
  toolCalls,
  valueHash,
  workKey,
} from '@sazuz/db';
import {
  browserCommandSchema,
  browserObservationSchema,
  type BrowserCommand,
} from '@sazuz/core/browser';
import { browserWorkerRequestSchema, signBrowserMessage } from '@sazuz/browser/protocol';
import { newCheckpoint } from '../../packages/runtime/src/loop.js';

export const browserCanary = 'phase5-form-secret-781936-bounded';
export async function browserFixture(
  options: {
    respond?: (request: {
      path: string;
      method: string;
      body: string;
    }) => { body: string; status?: number; headers?: Record<string, string> } | undefined;
  } = {},
) {
  let gateway: BrowserGateway | undefined;
  const fixture = await phaseFourFixture(
    (app, runtime) => {
      gateway = createBrowserGateway(runtime, (request, signal) => {
        return client(request, signal);
      });
      registerPhaseFive(app, runtime, gateway);
    },
    { maxConnections: 16 },
  );
  const keyPath = join(fixture.directory, 'fixture-key.pem'),
    certPath = join(fixture.directory, 'fixture-cert.pem');
  const openssl =
    process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl';
  try {
    await promisify(execFile)(
      openssl,
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
  } catch {
    throw new Error('The disposable HTTPS browser fixture requires OpenSSL.');
  }
  let submissions = 0,
    requests = 0;
  let loginCanaryReceived = false,
    detailsReceived = false;
  const site = createServer(
    { key: await readFile(keyPath), cert: await readFile(certPath) },
    (request, response) => {
      requests++;
      void (async () => {
        let body = '';
        for await (const chunk of request) {
          body += String(chunk);
          if (body.length > 16384) throw new Error('Fixture body too large.');
        }
        const path = new URL(request.url ?? '/', 'https://fixture.example').pathname;
        response.setHeader('content-type', 'text/html; charset=utf-8');
        const custom = options.respond?.({ path, method: request.method ?? 'GET', body });
        if (custom) {
          response.writeHead(custom.status ?? 200, custom.headers ?? {});
          response.end(custom.body);
          return;
        }
        const page = (title: string, content: string) =>
          `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${content}</body></html>`;
        if (path === '/login' && request.method === 'POST') {
          const fields = new URLSearchParams(body);
          loginCanaryReceived = fields.get('password') === browserCanary;
          response.writeHead(303, {
            'set-cookie': `fixtureSession=${browserCanary}; Secure; HttpOnly; SameSite=Strict; Path=/`,
            location: '/details',
          });
          response.end();
          return;
        }
        if (path === '/login') {
          response.end(
            page(
              'Sign in',
              '<form method="post"><label>Username<input name="username" autocomplete="username"></label><label>Password<input type="password" name="password" autocomplete="current-password"></label><button>Sign in</button></form>',
            ),
          );
          return;
        }
        if (path === '/details') {
          response.end(
            page(
              'Project details',
              `<p>Private session echo: ${browserCanary}</p><form method="post" action="/review"><label>Project name<input name="project"></label><label>Region<select name="region"><option>East</option><option>West</option></select></label><button>Review</button></form>`,
            ),
          );
          return;
        }
        if (path === '/review') {
          if (request.method === 'POST') {
            const fields = new URLSearchParams(body);
            detailsReceived =
              fields.get('project') === 'Launch project' && fields.get('region') === 'West';
          }
          response.end(
            page(
              'Review project',
              '<p>Ready to submit the project.</p><form method="post" action="/submitted"><button>Submit project</button></form>',
            ),
          );
          return;
        }
        if (path === '/submitted') {
          if (request.method === 'POST') submissions++;
          response.end(page('Project submitted', '<p>Confirmation: fixture-42.</p>'));
          return;
        }
        if (path === '/fields') {
          response.end(
            page(
              'Access form',
              '<label>Access code<input name="code" id="code"></label><button id="echo" onclick="document.getElementById(\'result\').textContent=document.getElementById(\'code\').value;localStorage.setItem(\'saved-code\',document.getElementById(\'code\').value)">Echo code</button><p id="result"></p><label>Upload file<input type="file"></label><a href="/export" download="data.csv">Download data</a>',
            ),
          );
          return;
        }
        if (path === '/payment') {
          response.end(
            page(
              'Checkout',
              '<label>Card number<input autocomplete="cc-number"></label><button>Pay now</button>',
            ),
          );
          return;
        }
        if (path === '/export') {
          response.setHeader('content-type', 'text/csv');
          response.setHeader('content-disposition', 'attachment; filename="data.csv"');
          response.end('name,count\nExample,42');
          return;
        }
        response.end(
          page('Start project', '<a href="/login">Start</a><a href="/fields">Access form</a>'),
        );
      })().catch(() => {
        response.statusCode = 500;
        response.end('Fixture request failed.');
      });
    },
  );
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  const sitePort = (site.address() as AddressInfo).port;
  const proxy = createEgressProxy({
    key: fixture.runtime.plumbing.operatorKey,
    resolve: (url, dependencies) =>
      resolvePublicUrl(url, {
        ...dependencies,
        lookup: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      }),
    dial: () => connect({ host: '127.0.0.1', port: sitePort }),
  });
  await new Promise<void>((resolve) => proxy.server.listen(0, '127.0.0.1', resolve));
  const proxyUrl = `http://127.0.0.1:${(proxy.server.address() as AddressInfo).port}`;
  const service = await createBrowserApp({
    database: fixture.db,
    key: fixture.runtime.plumbing.operatorKey,
    egressUrl: proxyUrl,
    ignoreHTTPSErrors: true,
    launch: () =>
      chromium.launch({
        headless: true,
        chromiumSandbox: true,
        ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
      }),
  });
  const serviceUrl = await service.app.listen({ host: '127.0.0.1', port: 0 });
  fixture.runtime.config.browserUrl = serviceUrl;
  const client = createBrowserClient({ browserUrl: serviceUrl }, () =>
    Promise.resolve(fixture.runtime.plumbing.operatorKey),
  );
  const security = {
    ...fixture.runtime.settings.security.value,
    agentDomains: [{ agentId: 'operator', domains: ['fixture.example'] }],
  };
  await saveSetting(fixture.db, {
    namespace: 'security',
    value: security,
    expectedVersion: fixture.runtime.settings.security.version,
    actorId: fixture.userId,
  });
  await saveSetting(fixture.db, {
    namespace: 'browser',
    value: { ...fixture.runtime.settings.browser.value, poolSize: 10 },
    expectedVersion: fixture.runtime.settings.browser.version,
    actorId: fixture.userId,
  });
  await vi.waitFor(() => {
    expect(fixture.runtime.settings.security.value.agentDomains).toHaveLength(1);
  });
  const workerId = workKey('wrk'),
    claimKey = randomUUID();
  async function mission(
    profileName = 'Test site',
    existingProfile?: Awaited<ReturnType<BrowserGateway['profiles']['create']>>,
  ) {
    const profile =
      existingProfile ??
      (await gateway!.profiles.create(fixture.userId, {
        projectId: fixture.projectId,
        agentId: 'operator',
        name: profileName,
        site: 'https://fixture.example',
      }));
    const mission = await createMission(
      fixture.db,
      fixture.userId,
      {
        projectId: fixture.projectId,
        goal: `Complete the form using profile ${profile.id}.`,
        agent: 'operator',
        requestId: randomUUID(),
      },
      { maxSteps: 100, maxCostUsd: 1, maxWallTimeSeconds: 600 },
    );
    let step = 0;
    async function prepare(command: BrowserCommand) {
      step++;
      const parsed = browserCommandSchema.parse(command),
        callKey = `${mission.run.id}:${step}:0`;
      const loop = newCheckpoint([{ role: 'user', content: 'Use the browser fixture.' }]);
      loop.step = step;
      loop.pendingCalls = [
        { id: `call-${step}`, name: `browser.${parsed.operation}`, args: parsed.args },
      ];
      await fixture.db.orm
        .update(runs)
        .set({
          status: 'running',
          agentId: 'operator',
          workerId,
          claimKey,
          checkpoint: {
            version: 1,
            loop,
            phase: 'direct',
            agentId: 'operator',
            plan: null,
            taskIndex: 0,
            results: [],
          },
        })
        .where(eq(runs.id, mission.run.id));
      await fixture.db.orm.insert(toolCalls).values({
        id: workKey('tc'),
        runId: mission.run.id,
        idempotencyKey: callKey,
        toolName: `browser.${parsed.operation}`,
        args: parsed.args,
        argsHash: valueHash(parsed.args),
        effect: 'write',
        status: 'intent',
      });
      return browserWorkerRequestSchema.parse({
        workerId,
        claimKey,
        runId: mission.run.id,
        callKey,
        command: parsed,
        verify: false,
        nonce: randomUUID(),
        expiresAt: Date.now() + 45000,
      });
    }
    async function send(message: Awaited<ReturnType<typeof prepare>>) {
      await recordHeartbeat(fixture.db, workerId);
      const response = await fixture.app.inject({
        method: 'POST',
        url: '/internal/browser-execution',
        headers: {
          'content-type': 'application/json',
          'x-sazuz-worker-signature': signBrowserMessage(
            fixture.runtime.plumbing.operatorKey,
            'worker',
            message,
          ),
        },
        payload: message,
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json<{ status: string; observation: unknown }>();
    }
    async function act(command: BrowserCommand) {
      const message = await prepare(command),
        result = await send(message);
      return { message, observation: browserObservationSchema.parse(result.observation) };
    }
    return { profile, mission, prepare, send, act };
  }
  return {
    ...fixture,
    get loginCanaryReceived() {
      return loginCanaryReceived;
    },
    get detailsReceived() {
      return detailsReceived;
    },
    gateway: gateway!,
    client,
    service,
    mission,
    workerId,
    claimKey,
    get submissions() {
      return submissions;
    },
    get requests() {
      return requests;
    },
    async close() {
      await service.app.close();
      await proxy.close();
      await new Promise<void>((resolve, reject) => {
        site.close((error) => (error ? reject(error) : resolve()));
        site.closeAllConnections();
      });
      await fixture.close();
    },
  };
}
