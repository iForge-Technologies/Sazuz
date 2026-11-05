import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { databaseConnection, type InfraConfig } from '@sazuz/config';
import { secretRedactor } from '@sazuz/vault';
import { MAX_BACKUP_BYTES, OperationsError } from '@sazuz/core/operations';

export interface DatabaseSnapshot {
  dump(): Promise<Buffer>;
  sql(dump: Uint8Array): Promise<Buffer>;
  restore(sql: Uint8Array, suffix: string): Promise<void>;
}
type Utility = 'pg_dump' | 'pg_restore' | 'psql';
/** Fixed executables and argument vectors; no shell, URI/password argv or stderr logging. */
export function postgresSnapshot(
  config: InfraConfig,
  options: { binaryDirectory?: string; timeoutMs?: number } = {},
): DatabaseSnapshot {
  const bundled =
    process.platform === 'win32'
      ? join(process.cwd(), '.tools/postgres/Library/bin')
      : '/opt/sazuz-postgres/bin';
  const directory = options.binaryDirectory ?? (existsSync(bundled) ? bundled : undefined);
  const binary = (name: Utility) =>
    directory ? join(directory, name + (process.platform === 'win32' ? '.exe' : '')) : name;
  async function environment() {
    const connection = await databaseConnection(config, secretRedactor);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      TMP: process.env.TMP,
      TEMP: process.env.TEMP,
      PGCONNECT_TIMEOUT: '5',
      PGAPPNAME: 'sazuz-operations',
      PGOPTIONS: '-c statement_timeout=120000 -c lock_timeout=15000',
      ...(directory === '/opt/sazuz-postgres/bin'
        ? { LD_LIBRARY_PATH: '/opt/sazuz-postgres/lib' }
        : {}),
    };
    if ('connectionString' in connection) {
      const url = new URL(connection.connectionString);
      Object.assign(env, {
        PGHOST: url.hostname.replace(/^\[|\]$/g, ''),
        PGPORT: url.port || '5432',
        PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
        PGUSER: decodeURIComponent(url.username),
        PGPASSWORD: decodeURIComponent(url.password),
      });
      for (const [key, variable] of [
        ['host', 'PGHOST'],
        ['port', 'PGPORT'],
        ['user', 'PGUSER'],
        ['password', 'PGPASSWORD'],
        ['dbname', 'PGDATABASE'],
        ['sslmode', 'PGSSLMODE'],
        ['sslrootcert', 'PGSSLROOTCERT'],
        ['sslcert', 'PGSSLCERT'],
        ['sslkey', 'PGSSLKEY'],
      ] as const) {
        const value = url.searchParams.get(key);
        if (value !== null) env[variable] = value;
      }
    } else
      Object.assign(env, {
        PGHOST: connection.host,
        PGPORT: String(connection.port),
        PGDATABASE: connection.database,
        PGUSER: connection.user,
        PGPASSWORD: connection.password,
      });
    return env;
  }
  async function execute(
    name: Utility,
    args: string[],
    chunks: readonly Uint8Array[] = [],
    limit = MAX_BACKUP_BYTES,
  ): Promise<Buffer> {
    const env = await environment();
    return new Promise((resolve, reject) => {
      const child = spawn(binary(name), args, {
        env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const output: Buffer[] = [];
      let bytes = 0,
        failed = false;
      const timeout = setTimeout(() => {
        failed = true;
        child.kill();
      }, options.timeoutMs ?? 120000);
      child.stdout.on('data', (value: Buffer) => {
        bytes += value.length;
        if (bytes > limit) {
          value.fill(0);
          failed = true;
          child.kill();
        } else output.push(value);
      });
      child.stderr.on('data', (value: Buffer) => value.fill(0));
      child.stdin.on('error', () => {
        failed = true;
      });
      child.once('error', () => {
        failed = true;
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        if (failed || code !== 0) {
          for (const data of output) data.fill(0);
          reject(new OperationsError(bytes > limit ? 'OPS_LIMIT' : 'OPS_DATABASE'));
        } else {
          const result = Buffer.concat(output);
          for (const data of output) data.fill(0);
          resolve(result);
        }
      });
      const write = async () => {
        for (const chunk of chunks) {
          if (failed) return;
          if (!child.stdin.write(chunk))
            await new Promise<void>((done) => {
              const complete = () => {
                child.stdin.off('drain', complete);
                child.stdin.off('close', complete);
                done();
              };
              child.stdin.once('drain', complete);
              child.stdin.once('close', complete);
            });
        }
        child.stdin.end();
      };
      void write().catch(() => {
        failed = true;
        child.kill();
      });
    });
  }
  return {
    dump: () =>
      execute('pg_dump', [
        '--no-password',
        '--format=custom',
        '--compress=0',
        '--no-owner',
        '--no-privileges',
        '--exclude-schema=sazuz_jobs',
      ]),
    sql: (dump) =>
      execute(
        'pg_restore',
        ['--file=-', '--no-owner', '--no-privileges'],
        [dump],
        MAX_BACKUP_BYTES * 4,
      ),
    async restore(sql, suffix) {
      // Transactional schema reset also removes objects introduced by a failed migration.
      // The transient queue schema is rebuilt from quarantined durable work after restart.
      const prefix = Buffer.from(
        'DROP SCHEMA IF EXISTS sazuz_jobs CASCADE;\nDROP SCHEMA IF EXISTS drizzle CASCADE;\nDROP SCHEMA public CASCADE;\nCREATE SCHEMA public;\n',
      );
      const tail = Buffer.from('\nSET search_path=public,pg_catalog;\n' + suffix + '\n');
      try {
        const result = await execute(
          'psql',
          ['-X', '--no-password', '--quiet', '--set=ON_ERROR_STOP=1', '--single-transaction'],
          [prefix, sql, tail],
          1024 * 1024,
        );
        result.fill(0);
      } finally {
        prefix.fill(0);
        tail.fill(0);
      }
    },
  };
}
