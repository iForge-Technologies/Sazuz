import { pino, type DestinationStream, type Logger } from 'pino';
import type { SecretRedactor } from '@sazuz/vault';

export function createLogger(
  service: string,
  redactor: SecretRedactor,
  destination?: DestinationStream,
): Logger {
  const target = destination ?? process.stdout;
  const safeDestination: DestinationStream = {
    write(line) {
      // Scrub at the final sink too: pino caches child bindings before each log call.
      const record: unknown = JSON.parse(line);
      target.write(`${JSON.stringify(redactor.redact(record))}\n`);
    },
  };
  return pino(
    {
      name: service,
      base: { service },
      level: 'info',
      serializers: { err: (error: unknown) => redactor.redact(error) },
      hooks: {
        logMethod(args, method) {
          const safeArgs = args.map((value) => redactor.redact(value));
          Reflect.apply(method, this, safeArgs);
        },
      },
      formatters: {
        bindings: (bindings) => redactor.redact(bindings) as Record<string, unknown>,
        log: (object) => redactor.redact(object) as Record<string, unknown>,
      },
    },
    safeDestination,
  );
}
