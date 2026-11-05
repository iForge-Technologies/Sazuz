import type { PoolClient } from 'pg';
import { z } from 'zod';
import { workId } from '@sazuz/core/work';
import type { Database } from '@sazuz/db';

const tokenSchema = z.strictObject({
  runId: workId,
  step: z.number().int().positive(),
  text: z.string().max(8000),
});
export type ChatToken = z.infer<typeof tokenSchema>;

/** Share one optional live-token connection; persisted messages remain authoritative. */
export function createChatTokens(database: Database) {
  const observers = new Map<string, Set<(token: ChatToken) => void>>();
  let connection: PoolClient | undefined;
  let connecting: Promise<void> | undefined;
  let closed = false;

  function disconnect() {
    const current = connection;
    connection = undefined;
    if (current) {
      current.removeAllListeners('notification');
      current.release(true);
    }
  }
  async function connect() {
    if (closed || connection) return;
    if (connecting) return connecting;
    connecting = (async () => {
      try {
        const current = await database.pool.connect();
        if (closed) {
          current.release();
          return;
        }
        connection = current;
        const lost = () => {
          if (connection !== current) return;
          disconnect();
          database.logger.warn(
            { code: 'CHAT_TOKENS_UNAVAILABLE' },
            'Live token updates stopped. Chat continues from saved messages.',
          );
        };
        current.on('error', lost);
        current.on('end', lost);
        current.on('notification', (notice) => {
          if (notice.channel !== 'run_token' || !notice.payload) return;
          let value: unknown;
          try {
            value = JSON.parse(notice.payload);
          } catch {
            database.logger.warn(
              { code: 'CHAT_TOKEN_INVALID' },
              'An invalid live token update was ignored.',
            );
            return;
          }
          const token = tokenSchema.safeParse(value);
          if (!token.success) {
            database.logger.warn(
              { code: 'CHAT_TOKEN_INVALID' },
              'An invalid live token update was ignored.',
            );
            return;
          }
          for (const observe of observers.get(token.data.runId) ?? []) observe(token.data);
        });
        await current.query('LISTEN run_token');
      } catch {
        disconnect();
        database.logger.warn(
          { code: 'CHAT_TOKENS_UNAVAILABLE' },
          'Live token updates are unavailable. Chat continues from saved messages.',
        );
      }
    })();
    try {
      await connecting;
    } finally {
      connecting = undefined;
    }
  }
  return {
    async subscribe(runId: string, observe: (token: ChatToken) => void) {
      if (closed) return () => {};
      const group = observers.get(runId) ?? new Set<(token: ChatToken) => void>();
      observers.set(runId, group);
      group.add(observe);
      await connect();
      return () => {
        group.delete(observe);
        if (!group.size) observers.delete(runId);
      };
    },
    async close() {
      closed = true;
      await connecting;
      disconnect();
      observers.clear();
    },
  };
}
