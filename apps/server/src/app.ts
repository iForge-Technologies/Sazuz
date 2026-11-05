import Fastify, { LogController } from 'fastify';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import websocket from '@fastify/websocket';
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { healthSchema, type Health, type createLogger } from '@sazuz/core';
import { z } from 'zod';
import { SettingsError, MissionError } from '@sazuz/db';
import { VaultError } from '@sazuz/vault';
import { TriggerError } from '@sazuz/triggers';
import { RequestError } from './phase-one-errors.js';
import { OrchestrationError } from '@sazuz/orchestrator';
import { MemoryError } from '@sazuz/memory';
import { SkillError } from '@sazuz/skills';
import { RecipeError } from '@sazuz/core/recipes';
import { SandboxError } from '@sazuz/core/sandbox';
import { BrowserError } from '@sazuz/core/browser';
import { McpError } from '@sazuz/core/mcp';
import { BridgeError } from '@sazuz/core/bridge';
import { WorkflowError } from '@sazuz/core/workflows';
import { LearningError } from '@sazuz/core/learning';
import { EvalError } from '@sazuz/core/evals';
import { OperationsError } from '@sazuz/core/operations';
import { VoiceError } from '@sazuz/core/voice';
import { PushError } from '@sazuz/core/push';
import { settleRequestHandler, startRequestHandler } from './request-activity.js';

type Logger = ReturnType<typeof createLogger>;

export async function createApp(options: { health: () => Promise<Health>; logger: Logger }) {
  const app = Fastify({
    loggerInstance: options.logger,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 131_072,
    requestTimeout: 5_000,
    connectionTimeout: 5_000,
    trustProxy: false,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(helmet);
  await app.register(websocket, { options: { maxPayload: 16_384 } });
  await app.register(swagger, {
    openapi: { info: { title: 'Sazuz API', version: '0.0.0' } },
    transform: jsonSchemaTransform,
  });

  app.addHook('onRoute', (route) => {
    const handler = route.handler;
    route.handler = async function (request, reply) {
      startRequestHandler(request);
      try {
        return await handler.call(this, request, reply);
      } finally {
        // A disconnected client cannot cancel an admitted mutation. Wait for
        // its handler, including hijacked streams, before releasing its lease.
        await settleRequestHandler(request, reply.raw.destroyed || reply.raw.writableFinished);
      }
    };
  });

  app.setErrorHandler((error, request, reply) => {
    if (
      error instanceof RequestError ||
      error instanceof VoiceError ||
      error instanceof PushError ||
      error instanceof OperationsError ||
      error instanceof OrchestrationError ||
      error instanceof SandboxError ||
      error instanceof BrowserError ||
      error instanceof McpError ||
      error instanceof BridgeError ||
      error instanceof MemoryError ||
      error instanceof SkillError ||
      error instanceof RecipeError ||
      error instanceof WorkflowError ||
      error instanceof LearningError ||
      error instanceof EvalError ||
      error instanceof TriggerError ||
      error instanceof MissionError ||
      error instanceof VaultError ||
      error instanceof SettingsError
    ) {
      const status =
        error instanceof VoiceError || error instanceof PushError
          ? error.code.endsWith('NOT_FOUND')
            ? 404
            : error.code.endsWith('DENIED')
              ? 403
              : error.code.endsWith('CONFLICT')
                ? 409
                : 400
          : error instanceof OperationsError
            ? error.code === 'OPS_BUSY'
              ? 503
              : error.code === 'OPS_POLICY'
                ? 403
                : error.code === 'OPS_NOT_FOUND'
                  ? 404
                  : 400
            : error instanceof LearningError && error.code === 'LEARNING_DENIED'
              ? 403
              : error instanceof SandboxError ||
                  error instanceof BrowserError ||
                  error instanceof McpError ||
                  error instanceof BridgeError
                ? error.code.endsWith('UNAVAILABLE')
                  ? 503
                  : error.code.endsWith('DENIED')
                    ? 403
                    : 409
                : error instanceof OrchestrationError ||
                    error instanceof MemoryError ||
                    error instanceof SkillError ||
                    error instanceof WorkflowError ||
                    error instanceof LearningError ||
                    error instanceof EvalError ||
                    error instanceof RecipeError
                  ? error.code.endsWith('NOT_FOUND')
                    ? 404
                    : error.code.endsWith('CONFLICT')
                      ? 409
                      : 400
                  : error instanceof TriggerError
                    ? error.code === 'WEBHOOK_REPLAYED'
                      ? 409
                      : error.code === 'WEBHOOK_TOO_LARGE'
                        ? 413
                        : error.code === 'WEBHOOK_SECRET_UNAVAILABLE' ||
                            error.code === 'WEBHOOK_RECEIPT_FAILED'
                          ? 503
                          : error.code === 'INVALID_WEBHOOK' || error.code === 'WEBHOOK_EXPIRED'
                            ? 401
                            : error.code === 'SCHEDULE_MODEL_FAILED'
                              ? 502
                              : 400
                    : error instanceof MissionError
                      ? error.code === 'MISSION_NOT_FOUND'
                        ? 404
                        : error.code.includes('CONFLICT') || error.code === 'MISSION_BUSY'
                          ? 409
                          : 400
                      : error instanceof RequestError
                        ? error.status
                        : error.code.includes('CONFLICT')
                          ? 409
                          : error.code === 'VAULT_LOCKED'
                            ? 423
                            : 400;
      reply.header('Cache-Control', 'no-store');
      void reply.code(status).send({ error: { code: error.code, message: error.message } });
      return;
    }
    const parserCode = error instanceof Error && 'code' in error ? error.code : null;
    const tooLarge = parserCode === 'FST_ERR_CTP_BODY_TOO_LARGE';
    const invalidRequest =
      error instanceof Error &&
      ('validation' in error ||
        parserCode === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
        parserCode === 'FST_ERR_CTP_EMPTY_JSON_BODY');
    const code = tooLarge
      ? 'REQUEST_TOO_LARGE'
      : invalidRequest
        ? 'INVALID_REQUEST'
        : 'INTERNAL_ERROR';
    request.log.error({ code }, 'Request failed.');
    reply.header('Cache-Control', 'no-store');
    void reply.code(tooLarge ? 413 : invalidRequest ? 400 : 500).send({
      error: {
        code,
        message: tooLarge
          ? 'The request body exceeds the size limit.'
          : invalidRequest
            ? 'Request validation failed.'
            : 'The request could not be completed.',
      },
    });
  });

  app.setNotFoundHandler((_request, reply) => {
    // Fastify's default 404 echoes the URL, which can include credentials.
    reply.header('Cache-Control', 'no-store');
    void reply.code(404).send({
      error: { code: 'NOT_FOUND', message: 'The requested endpoint does not exist.' },
    });
  });

  app.get(
    '/api/health',
    {
      schema: {
        summary: 'Read database and worker readiness',
        querystring: z.strictObject({}),
        response: { 200: healthSchema, 503: healthSchema },
      },
    },
    async (_request, reply) => {
      const health = healthSchema.parse(await options.health());
      reply.header('Cache-Control', 'no-store');
      return reply.code(health.status === 'ok' ? 200 : 503).send(health);
    },
  );

  app.get(
    '/api/openapi.json',
    {
      schema: {
        hide: true,
        querystring: z.strictObject({}),
        response: { 200: z.record(z.string(), z.unknown()) },
      },
    },
    async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return z.record(z.string(), z.unknown()).parse(app.swagger());
    },
  );

  return app;
}
