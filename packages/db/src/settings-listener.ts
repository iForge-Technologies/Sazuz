import type { PoolClient } from 'pg';
import { namespaceSchema, type SettingsDocument } from '@sazuz/config/settings';
import type { Database } from './client.js';
import { readSettings } from './settings.js';

/** LISTEN before snapshot, then serialize reloads; reconnect always takes a full snapshot. */
export async function listenSettings(
  database: Database,
  apply: (document: SettingsDocument) => Promise<void> | void,
) {
  let stopped = false;
  let client: PoolClient | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let queue = Promise.resolve();
  let current: SettingsDocument | undefined;
  let dirty = false;

  const refresh = () => {
    dirty = true;
    queue = queue
      .then(async () => {
        if (stopped || !dirty) return;
        dirty = false;
        const document = await readSettings(database);
        await apply(document);
        current = document;
      })
      .catch(() => {
        database.logger.error(
          { code: 'SETTINGS_RELOAD_FAILED' },
          'Settings reload failed; retrying.',
        );
        schedule();
      });
    return queue;
  };
  const disconnect = () => {
    const connection = client;
    client = undefined;
    if (connection) {
      connection.removeAllListeners('notification');
      connection.release(true);
    }
  };
  const schedule = () => {
    if (stopped || retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      void connect().catch(() => {
        database.logger.warn(
          { code: 'SETTINGS_LISTEN_RETRY' },
          'Settings listener will reconnect.',
        );
        schedule();
      });
    }, 250);
    retry.unref();
  };
  const connect = async () => {
    disconnect();
    if (stopped) return;
    const connection = await database.pool.connect();
    if (stopped) {
      connection.release();
      return;
    }
    client = connection;
    connection.on('error', () => {
      if (client === connection) {
        disconnect();
        schedule();
      }
    });
    connection.on('end', () => {
      if (client === connection) {
        disconnect();
        schedule();
      }
    });
    connection.on('notification', (message) => {
      if (
        message.channel === 'settings_changed' &&
        (namespaceSchema.safeParse(message.payload).success ||
          /^project:prj_[0-9A-HJKMNP-TV-Z]{26}:review$/.test(message.payload ?? '') ||
          /^(?:mcp|mcp-client|bridge):[a-z]+_[0-9A-HJKMNP-TV-Z]{26}$/.test(message.payload ?? ''))
      )
        void refresh();
    });
    await connection.query('LISTEN settings_changed');
    await refresh();
  };
  try {
    await connect();
  } catch (error) {
    disconnect();
    throw error;
  }
  return {
    get current() {
      return current;
    },
    async close() {
      stopped = true;
      if (retry) clearTimeout(retry);
      await queue;
      disconnect();
    },
  };
}
