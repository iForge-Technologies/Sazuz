import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { triggerConfigSchema } from '@sazuz/core/missions';
import { projects, triggers } from '@sazuz/db';
import { triggerMission } from '@sazuz/runtime';
import { verifyWebhook, WEBHOOK_MAX_BYTES } from '@sazuz/triggers';
import { secretRedactor, type SecretReference } from '@sazuz/vault';
import type { createApp } from './app.js';
import type { PhaseOne } from './phase-one.js';
import { RequestError } from './phase-one-errors.js';
import { emptyRequest, parseRequest, workPath } from './phase-three-shared.js';

export function registerWebhooks(app: Awaited<ReturnType<typeof createApp>>, runtime: PhaseOne) {
  // Parser replacement is encapsulated here so authenticated JSON APIs keep their parser.
  void app.register((hooks, _options, done) => {
    hooks.removeAllContentTypeParsers();
    hooks.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: WEBHOOK_MAX_BYTES },
      (_request, body, done) => done(null, body),
    );
    hooks.post('/hooks/:id', { bodyLimit: WEBHOOK_MAX_BYTES }, async (request, reply) => {
      const { id } = parseRequest(workPath, request.params);
      parseRequest(emptyRequest, request.query);
      const body = parseRequest(z.instanceof(Uint8Array), request.body);
      await runtime.rateLimit(`webhook:${id}`, 120);
      const [row] = await runtime.database.orm
        .select({ trigger: triggers, userId: projects.userId })
        .from(triggers)
        .innerJoin(projects, eq(projects.id, triggers.projectId))
        .where(and(eq(triggers.id, id), eq(triggers.enabled, true)));
      const config = triggerConfigSchema.safeParse(row?.trigger.config);
      if (!row || !config.success || config.data.kind !== 'webhook')
        throw new RequestError('NOT_FOUND', 404, 'This webhook is unavailable.');
      const receipt = await verifyWebhook(
        {
          triggerId: id,
          secretRef: config.data.secretRef,
          headers: request.headers,
          body,
          now: new Date(),
        },
        {
          withSecret: (reference, consume) =>
            runtime.vault.withSecret(reference as SecretReference, 'user', consume),
        },
      );
      const payload = JSON.stringify({
        body: secretRedactor.redactText(Buffer.from(body).toString('utf8')).slice(0, 3000),
        bodySha256: receipt.bodySha256,
        deliveryId: receipt.deliveryId,
      });
      // triggerMission commits the receipt, mission, run and queue outbox in one transaction.
      const missionId = await triggerMission(
        runtime.database,
        row.userId,
        id,
        () => runtime.settings,
        { key: receipt.dedupeKey, payload, tainted: true },
      );
      if (!missionId)
        throw new RequestError(
          'WEBHOOK_REPLAYED',
          409,
          'This webhook delivery was already accepted.',
        );
      return reply.code(202).send({ accepted: true });
    });
    done();
  });
}
