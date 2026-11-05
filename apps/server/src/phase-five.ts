import { z } from 'zod';
import { sandboxDiagnosticsSchema, sandboxExecutionSchema } from '@sazuz/core/sandbox';
import { listSandboxExecutions, sandboxDiagnostics } from '@sazuz/sandbox';
import type { createApp } from './app.js';
import type { PhaseOne } from './phase-one.js';
import { emptyRequest } from './phase-three-shared.js';
import {
  browserProfileInputSchema,
  browserProfileSchema,
  browserProfileUpdateSchema,
  browserProfileId,
  browserSessionSchema,
  browserVersionSchema,
} from '@sazuz/core/browser';
import {
  createBrowserGateway,
  registerBrowserExecution,
  type BrowserGateway,
} from './phase-five-execution.js';
import { createBrowserControl, registerBrowserControl } from './phase-five-control.js';
import { registerBrowserLive } from './phase-five-live.js';
import { registerRecording } from './phase-nine-recording.js';

export function registerPhaseFive(
  app: Awaited<ReturnType<typeof createApp>>,
  runtime: PhaseOne,
  gateway: BrowserGateway = createBrowserGateway(runtime),
) {
  registerBrowserExecution(app, runtime, gateway);
  const controls = createBrowserControl(runtime, gateway);
  registerBrowserControl(app, runtime, gateway, controls);
  registerRecording(app, runtime, gateway, controls);
  registerBrowserLive(app, runtime, controls);
  async function diagnostics() {
    const [base, browser] = await Promise.all([
      sandboxDiagnostics(runtime.config, runtime.plumbing.operatorKey),
      gateway.client({ mode: 'health' }, AbortSignal.timeout(2500)).then(
        (value) => (value.ready === true ? ('ready' as const) : ('unavailable' as const)),
        () => 'unavailable' as const,
      ),
    ]);
    return sandboxDiagnosticsSchema.parse({
      ...base,
      browser,
      hint: `${base.hint}${browser === 'unavailable' ? ' Start the browser Compose profile to enable live browser sessions.' : ' Chromium is running.'}`,
    });
  }
  app.get(
    '/api/setup/diagnostics',
    { schema: { querystring: emptyRequest, response: { 200: sandboxDiagnosticsSchema } } },
    async (request) => {
      await runtime.requireSetup(request, false);
      return diagnostics();
    },
  );
  app.get(
    '/api/browser/diagnostics',
    { schema: { querystring: emptyRequest, response: { 200: sandboxDiagnosticsSchema } } },
    async (request) => {
      await runtime.admin(request);
      return diagnostics();
    },
  );
  const path = z.strictObject({ id: browserProfileId });
  app.get(
    '/api/browser/profiles',
    { schema: { querystring: emptyRequest, response: { 200: z.array(browserProfileSchema) } } },
    async (request) => gateway.profiles.list((await runtime.admin(request)).user.id),
  );
  app.post(
    '/api/browser/profiles',
    { schema: { body: browserProfileInputSchema, response: { 200: browserProfileSchema } } },
    async (request) =>
      gateway.profiles.create((await runtime.admin(request)).user.id, request.body),
  );
  app.put(
    '/api/browser/profiles/:id',
    {
      schema: {
        params: path,
        body: browserProfileUpdateSchema,
        response: { 200: browserProfileSchema },
      },
    },
    async (request) =>
      gateway.profiles.update(
        (await runtime.admin(request)).user.id,
        request.params.id,
        request.body,
      ),
  );
  app.post(
    '/api/browser/profiles/:id/sign-out',
    {
      schema: { params: path, body: browserVersionSchema, response: { 200: browserProfileSchema } },
    },
    async (request) =>
      gateway.profiles.revoke(
        (await runtime.admin(request)).user.id,
        request.params.id,
        request.body.version,
        false,
      ),
  );
  app.delete(
    '/api/browser/profiles/:id',
    {
      schema: { params: path, body: browserVersionSchema, response: { 200: browserProfileSchema } },
    },
    async (request) =>
      gateway.profiles.revoke(
        (await runtime.admin(request)).user.id,
        request.params.id,
        request.body.version,
        true,
      ),
  );
  app.get(
    '/api/browser/sessions',
    { schema: { querystring: emptyRequest, response: { 200: z.array(browserSessionSchema) } } },
    async (request) => gateway.profiles.sessions((await runtime.admin(request)).user.id),
  );
  app.get(
    '/api/sandbox/executions',
    { schema: { querystring: emptyRequest, response: { 200: z.array(sandboxExecutionSchema) } } },
    async (request) => {
      const { user } = await runtime.admin(request);
      return listSandboxExecutions(runtime.database, user.id);
    },
  );
  app.get(
    '/api/sandbox/diagnostics',
    { schema: { querystring: emptyRequest, response: { 200: sandboxDiagnosticsSchema } } },
    async (request) => {
      await runtime.admin(request);
      return diagnostics();
    },
  );
}
