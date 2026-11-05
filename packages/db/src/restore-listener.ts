import type { Notification } from 'pg';
import { SazuzError } from '@sazuz/core';
import { operationIdSchema } from '@sazuz/core/operations';
import type { Database } from './client.js';

/** A restored database invalidates worker queue objects, settings and execution credentials. */
export async function listenForRestore(db: Database, restart: () => void) {
  const client = await db.coordination.connect().catch(() => {
    throw new SazuzError('RESTORE_LISTENER_FAILED', 'The restore listener could not start.');
  });
  let closed = false,
    requested = false;
  const request = () => {
    if (!closed && !requested) {
      requested = true;
      restart();
    }
  };
  const notification = (message: Notification) => {
    if (
      message.channel === 'instance_restored' &&
      operationIdSchema.safeParse(message.payload).success
    )
      request();
  };
  const disconnected = () => {
    db.logger.warn(
      { code: 'RESTORE_LISTENER_LOST' },
      'The worker is restarting to reload instance state.',
    );
    request();
  };
  client.on('notification', notification);
  client.on('error', disconnected);
  client.on('end', disconnected);
  try {
    await client.query('LISTEN instance_restored');
  } catch {
    closed = true;
    client.off('notification', notification);
    client.off('error', disconnected);
    client.off('end', disconnected);
    client.release(true);
    throw new SazuzError('RESTORE_LISTENER_FAILED', 'The restore listener could not start.');
  }
  return {
    async close() {
      if (closed) return;
      closed = true;
      client.off('notification', notification);
      try {
        await client.query('UNLISTEN instance_restored');
        client.release();
      } catch {
        client.release(true);
        db.logger.warn(
          { code: 'RESTORE_LISTENER_CLOSE_FAILED' },
          'The restore listener connection was closed.',
        );
      } finally {
        client.off('error', disconnected);
        client.off('end', disconnected);
      }
    },
  };
}
