import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { readPrivateFiles } from '@sazuz/config/private-files';
import { createWebPushSender, type PushSender } from '@sazuz/channels';
import { createPushService } from '@sazuz/runtime';
import { users, withActivity } from '@sazuz/db';
import { pushDeviceSchema, pushEnrollSchema, pushStatusSchema, PushError } from '@sazuz/core/push';
import { workId } from '@sazuz/core/work';
import type { createApp } from './app.js';
import type { PhaseOne } from './phase-one.js';
import { emptyRequest } from './phase-three-shared.js';

export function registerPush(
  app: Awaited<ReturnType<typeof createApp>>,
  runtime: PhaseOne,
  options: { send?: PushSender; background?: boolean } = {},
) {
  const send =
    options.send ??
    createWebPushSender({
      publicKey: runtime.plumbing.vapidPublicKey,
      privateKey: async () => {
        const files = await readPrivateFiles(runtime.config.dataDir, [
          { name: 'vapid.key', maxBytes: 44 },
        ]);
        return files.get('vapid.key')!.toString('utf8').trim();
      },
      subject: async () => {
        const owner = (await runtime.state()).adminId;
        const [user] = owner
          ? await runtime.database.orm.select().from(users).where(eq(users.id, owner))
          : [];
        if (!user) throw new PushError('PUSH_DISABLED');
        return `mailto:${user.email}`;
      },
    });
  const push = createPushService({
    database: runtime.database,
    vault: runtime.vault,
    publicKey: runtime.plumbing.vapidPublicKey,
    send,
  });
  app.get(
    '/api/channels/push',
    { schema: { querystring: emptyRequest, response: { 200: pushStatusSchema } } },
    async (request) => push.status((await runtime.admin(request)).user.id),
  );
  app.post(
    '/api/channels/push',
    { schema: { body: pushEnrollSchema, response: { 200: pushDeviceSchema } } },
    async (request) => {
      const { user } = await runtime.admin(request);
      await runtime.rateLimit(`push:${user.id}`, 10, 300);
      return push.enroll(user.id, request.body);
    },
  );
  app.delete(
    '/api/channels/push/:id',
    {
      schema: {
        params: z.strictObject({ id: workId }),
        body: emptyRequest,
        response: { 200: pushDeviceSchema },
      },
    },
    async (request) => push.revoke((await runtime.admin(request)).user.id, request.params.id),
  );
  let stopped = false;
  let running: Promise<unknown> | undefined;
  const tick = () => {
    if (stopped || running) return;
    running = withActivity(runtime.database, () => push.tick())
      .catch(() => {
        runtime.database.logger.warn(
          { code: 'PUSH_TICK_FAILED' },
          'Browser notifications could not be checked.',
        );
      })
      .finally(() => {
        running = undefined;
      });
  };
  const timer = options.background === false ? undefined : setInterval(tick, 15000);
  timer?.unref();
  app.addHook('onClose', async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  });
  return push;
}
