import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  McpError,
  mcpInspectSchema,
  mcpSaveSchema,
  mcpClientInputSchema,
  integrationControlSchema,
} from '@sazuz/core/mcp';
import {
  mcpConnection,
  getMcpServer,
  listMcpServers,
  mcpHistory,
  saveMcpServer,
  controlMcpServer,
  markMcpChanged,
  ownedProject,
  listMcpClients,
  saveMcpClient,
  controlMcpClient,
  authenticateMcpClient,
  incomingMcpServer,
  type McpConnectionOptions,
} from '@sazuz/mcp';
import type { createApp } from './app.js';
import type { PhaseOne } from './phase-one.js';
import { emptyRequest, parseRequest, workPath } from './phase-three-shared.js';
import { RequestError } from './phase-one-errors.js';
import { createExternalGateway, registerExternalExecution } from './phase-seven-execution.js';
import { registerBridge } from './phase-seven-bridge.js';

export function registerPhaseSeven(
  app: Awaited<ReturnType<typeof createApp>>,
  runtime: PhaseOne,
  overrides: Pick<McpConnectionOptions, 'transport'> = {},
) {
  const db = runtime.database;
  const resolve: McpConnectionOptions['secret'] = (reference, consume) =>
    runtime.vault.withSecret(reference, 'user', consume);
  const connect = mcpConnection({
    config: runtime.config,
    key: () => Promise.resolve(runtime.plumbing.operatorKey),
    secret: resolve,
    onError: (code) => db.logger.warn({ code }, 'MCP transport failed or closed unexpectedly.'),
    ...overrides,
  });
  const bridge = registerBridge(app, runtime);
  const gateway = createExternalGateway(runtime, connect, bridge);
  registerExternalExecution(app, runtime, gateway);
  app.get('/api/mcp/servers', async (request) => {
    const { user } = await runtime.admin(request);
    parseRequest(emptyRequest, request.query);
    return listMcpServers(db, user.id);
  });
  app.post('/api/mcp/inspect', async (request) => {
    const { user } = await runtime.admin(request);
    const input = parseRequest(mcpInspectSchema, request.body);
    await runtime.rateLimit(`mcp-inspect:${user.id}`, 10);
    await ownedProject(db, user.id, input.projectId);
    request.raw.socket?.setTimeout?.(50_000);
    return connect(
      input.transport,
      { projectId: input.projectId, agentId: 'owner', signal: AbortSignal.timeout(45_000) },
      (_client, catalogue) => Promise.resolve(catalogue),
    );
  });
  app.post('/api/mcp/servers', async (request) => {
    const { user } = await runtime.admin(request);
    await runtime.rateLimit(`mcp-save:${user.id}`, 10);
    request.raw.socket?.setTimeout?.(50_000);
    return saveMcpServer(db, user.id, null, parseRequest(mcpSaveSchema, request.body), connect);
  });
  app.get('/api/mcp/servers/:id', async (request) => {
    const { user } = await runtime.admin(request);
    const { id } = parseRequest(workPath, request.params);
    parseRequest(emptyRequest, request.query);
    return getMcpServer(db, user.id, id);
  });
  app.put('/api/mcp/servers/:id', async (request) => {
    const { user } = await runtime.admin(request);
    const { id } = parseRequest(workPath, request.params);
    await runtime.rateLimit(`mcp-save:${user.id}`, 10);
    request.raw.socket?.setTimeout?.(50_000);
    return saveMcpServer(db, user.id, id, parseRequest(mcpSaveSchema, request.body), connect);
  });
  app.get('/api/mcp/servers/:id/history', async (request) => {
    const { user } = await runtime.admin(request);
    const { id } = parseRequest(workPath, request.params);
    parseRequest(emptyRequest, request.query);
    return mcpHistory(db, user.id, id);
  });
  app.post('/api/mcp/servers/:id/control', async (request) => {
    const { user } = await runtime.admin(request);
    const { id } = parseRequest(workPath, request.params);
    return controlMcpServer(db, user.id, id, parseRequest(integrationControlSchema, request.body));
  });
  app.post('/api/mcp/servers/:id/inspect', async (request) => {
    const { user } = await runtime.admin(request);
    const { id } = parseRequest(workPath, request.params);
    parseRequest(emptyRequest, request.body);
    await runtime.rateLimit(`mcp-inspect:${user.id}`, 10);
    const current = await getMcpServer(db, user.id, id);
    request.raw.socket?.setTimeout?.(50_000);
    const catalogue = await connect(
      current.configuration.transport,
      { projectId: current.projectId, agentId: 'owner', signal: AbortSignal.timeout(45_000) },
      (_client, value) => Promise.resolve(value),
    );
    if (catalogue.sha256 !== current.configuration.catalogue.sha256)
      await markMcpChanged(db, { serverId: id, version: current.version });
    return catalogue;
  });
  app.get('/api/mcp/clients', async (request) => {
    const { user } = await runtime.admin(request);
    parseRequest(emptyRequest, request.query);
    return listMcpClients(db, user.id);
  });
  app.post('/api/mcp/clients', async (request) => {
    const { user } = await runtime.admin(request);
    await runtime.rateLimit(`mcp-client:${user.id}`, 20);
    return saveMcpClient(db, user.id, parseRequest(mcpClientInputSchema, request.body), resolve);
  });
  app.post('/api/mcp/clients/:id/control', async (request) => {
    const { user } = await runtime.admin(request);
    const { id } = parseRequest(workPath, request.params);
    return controlMcpClient(db, user.id, id, parseRequest(integrationControlSchema, request.body));
  });
  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    handler: async (request, reply) => {
      parseRequest(emptyRequest, request.query);
      if (
        request.headers.origin &&
        request.headers.origin !== new URL(runtime.settings.general.value.baseUrl).origin
      )
        throw new McpError('MCP_DENIED');
      const authenticate = () => authenticateMcpClient(db, request.headers.authorization, resolve);
      let client;
      try {
        client = await authenticate();
      } catch {
        throw new RequestError(
          'MCP_AUTH_REQUIRED',
          401,
          'A current scoped MCP bearer credential is required.',
        );
      }
      await runtime.rateLimit(`mcp-incoming:${client.id}`, 60);
      if (request.method !== 'POST')
        return reply
          .code(405)
          .header('Allow', 'POST')
          .send({
            error: { code: 'MCP_STATELESS', message: 'Use Streamable HTTP POST requests.' },
          });
      const body = parseRequest(z.record(z.string(), z.json()), request.body);
      const server = incomingMcpServer({ db, authenticate, getSettings: () => runtime.settings });
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);
      reply.hijack();
      reply.raw.once('close', () => {
        void server
          .close()
          .catch(() =>
            db.logger.warn({ code: 'MCP_CLOSE_FAILED' }, 'MCP transport cleanup failed.'),
          );
      });
      await transport.handleRequest(request.raw, reply.raw, body);
    },
  });
  return { connect, gateway };
}
