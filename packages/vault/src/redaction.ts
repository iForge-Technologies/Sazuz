import { z } from 'zod';

export const REDACTED = '[REDACTED]';

const secretSchema = z.string().min(1);
const sensitiveField =
  /(?:password|passwd|passphrase|apikey|accesstoken|refreshtoken|idtoken|clientsecret|privatekey|authorization|token|secret)$/;
const sensitiveFieldNames = new Set([
  'pwd',
  'cookie',
  'setcookie',
  'credentials',
  'connectionstring',
  'databaseurl',
  'dsn',
]);
// Token boundaries prevent failed greedy scans from restarting at every character.
const credentialAssignment =
  /(?<![\w-])(["']?[\w-]*(?:password|passwd|passphrase|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|pwd|secret|token|authorization|cookie|set-cookie)["']?\s*[:=](?!\/\/)\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[REDACTED\]|[^\s,;&}\]]+)/gi;
const commonPatterns = [
  /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /(?<![\w-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g,
];

export class SecretRegistrationError extends Error {
  readonly code = 'INVALID_SECRET_REGISTRATION';

  constructor() {
    super('The value cannot be registered for secret redaction.');
    this.name = 'SecretRegistrationError';
  }
}

function isSensitiveField(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return sensitiveFieldNames.has(normalized) || sensitiveField.test(normalized);
}

function literalPattern(value: string): string {
  return value
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/%[0-9a-f]{2}/gi, (encoded) =>
      encoded.replace(/[a-f]/gi, (letter) => `[${letter.toUpperCase()}${letter.toLowerCase()}]`),
    );
}

export interface SecretTextStream {
  push(value: string): string;
  finish(): string;
  discard(): void;
}

const streamSensitiveKey = String.raw`["']?[\w-]*(?:password|passwd|passphrase|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|pwd|secret|token|authorization|cookie|set-cookie)["']?`;
const streamAssignment = new RegExp(
  String.raw`(?<![\w-])${streamSensitiveKey}\s*[:=](?!\/\/)\s*`,
  'gi',
);
const streamPendingKey = new RegExp(String.raw`(?<![\w-])${streamSensitiveKey}\s*$`, 'i');

/** Retain incomplete tokens, secret prefixes and credential forms whose match can still grow. */
function streamingBoundary(value: string, variants: ReadonlySet<string>): number {
  let boundary = 0;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    if (/\s/.test(value[index]!)) {
      boundary = index + 1;
      break;
    }
  }
  if (boundary === 0) return 0;

  const pendingKey = streamPendingKey.exec(value);
  if (pendingKey) boundary = Math.min(boundary, pendingKey.index);
  const bearer = /\b(?:Bearer|Basic)\s+[-A-Za-z0-9+/_=.]*$/i.exec(value);
  if (bearer) boundary = Math.min(boundary, bearer.index);
  const lastLine = Math.max(value.lastIndexOf('\n'), value.lastIndexOf('\r')) + 1;
  if (
    /^[ \t]*(?:set-cookie|cookie|authorization|proxy-authorization)[ \t]*:/i.test(
      value.slice(lastLine),
    )
  )
    boundary = Math.min(boundary, lastLine);

  for (const match of value.matchAll(streamAssignment)) {
    const start = match.index + match[0].length;
    const rest = value.slice(start);
    const quote = rest[0];
    let end = -1;
    if (quote === '"' || quote === "'") {
      for (let index = 1; index < rest.length; index += 1) {
        if (rest[index] === '\\') index += 1;
        else if (rest[index] === quote) {
          end = index + 1;
          break;
        }
      }
    } else end = rest.search(/[\s,;&}\]]/);
    if (end === -1 || (match.index < boundary && start + end > boundary))
      boundary = Math.min(boundary, match.index);
  }

  const pemStart = value.lastIndexOf('-----BEGIN ');
  if (pemStart !== -1 && !/-----END (?:[A-Z]+ )?[A-Z]+-----/.test(value.slice(pemStart)))
    boundary = Math.min(boundary, pemStart);
  for (const pattern of [credentialAssignment, ...commonPatterns]) {
    for (const match of value.matchAll(pattern)) {
      if (match.index < boundary && match.index + match[0].length > boundary)
        boundary = match.index;
    }
  }

  const normalized = value.replace(/%[0-9a-f]{2}/gi, (part) => part.toUpperCase());
  for (const variant of variants) {
    // A known secret may contain spaces or line breaks; never split even a complete match.
    for (const match of value.matchAll(new RegExp(literalPattern(variant), 'g'))) {
      if (match.index < boundary && match.index + match[0].length > boundary)
        boundary = match.index;
    }
    const candidate = variant.replace(/%[0-9a-f]{2}/gi, (part) => part.toUpperCase());
    let index = normalized.lastIndexOf(candidate[0]!);
    while (index >= 0 && normalized.length - index < candidate.length) {
      if (candidate.startsWith(normalized.slice(index))) boundary = Math.min(boundary, index);
      if (index === 0) break;
      index = normalized.lastIndexOf(candidate[0]!, index - 1);
    }
  }
  return boundary;
}

/**
 * A process-lifetime registry shared by logging and model-bound output scrubbing.
 * Entries are never evicted: a late error can still contain a retired credential.
 */
export class SecretRedactor {
  #variants = new Set<string>();
  #matcher: RegExp | undefined;

  register(value: string): void {
    if (!secretSchema.safeParse(value).success) {
      throw new SecretRegistrationError();
    }

    let encoded: string;
    try {
      encoded = encodeURIComponent(value);
    } catch {
      throw new SecretRegistrationError();
    }
    const jsonEncoded = JSON.stringify(value).slice(1, -1);
    for (const variant of [value, encoded, encoded.replaceAll('%20', '+'), jsonEncoded]) {
      this.#variants.add(variant);
    }
    this.#matcher = undefined;
  }

  /**
   * Incrementally scrub prose while retaining ambiguous credentials across arbitrary chunks.
   * Call discard after cancellation/failure; finish is only for a completed model response.
   */
  createStream(): SecretTextStream {
    let pending = '';
    let finished = false;
    return {
      push: (value) => {
        if (finished) throw new SecretRegistrationError();
        pending += value;
        const boundary = streamingBoundary(pending, this.#variants);
        const safe = this.redactText(pending.slice(0, boundary));
        pending = pending.slice(boundary);
        return safe;
      },
      finish: () => {
        if (finished) throw new SecretRegistrationError();
        finished = true;
        const safe = this.redactText(pending);
        pending = '';
        return safe;
      },
      discard: () => {
        pending = '';
        finished = true;
      },
    };
  }

  redactText(value: string): string {
    if (this.#variants.size > 0 && this.#matcher === undefined) {
      this.#matcher = new RegExp(
        [...this.#variants]
          .sort((left, right) => right.length - left.length)
          .map(literalPattern)
          .join('|'),
        'g',
      );
    }

    let result = this.#matcher === undefined ? value : value.replace(this.#matcher, REDACTED);
    result = result.replace(
      /(?<![\w+.-])([a-z][a-z\d+.-]*:\/\/)[^\s/?#@]+@/gi,
      (_match, scheme: string) => `${scheme}${REDACTED}@`,
    );
    result = result.replace(/\b(Bearer|Basic)\s+[-A-Za-z0-9+/_=.]+/gi, `$1 ${REDACTED}`);
    result = result.replace(
      /^([ \t]*(?:set-cookie|cookie|authorization|proxy-authorization)[ \t]*:[ \t]*)[^\r\n]*/gim,
      `$1${REDACTED}`,
    );
    result = result.replace(credentialAssignment, (_match, key: string, credential: string) => {
      const quote = credential.startsWith('"') ? '"' : credential.startsWith("'") ? "'" : '';
      return `${key}${quote}${REDACTED}${quote}`;
    });
    for (const pattern of commonPatterns) {
      result = result.replace(pattern, REDACTED);
    }
    return result;
  }

  redact(value: string): string;
  redact(value: unknown): unknown;
  redact(value: unknown): unknown {
    return this.#visit(value, new WeakSet<object>(), false, 0);
  }

  #visit(value: unknown, ancestors: WeakSet<object>, sensitive: boolean, depth: number): unknown {
    if (value === null || value === undefined) {
      return value;
    }
    if (typeof value === 'string') {
      return sensitive ? REDACTED : this.redactText(value);
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return sensitive ? REDACTED : value;
    }
    if (typeof value === 'bigint' || typeof value === 'symbol') {
      return sensitive ? REDACTED : this.redactText(String(value));
    }
    if (typeof value !== 'object' || depth >= 64) {
      return REDACTED;
    }
    if (ancestors.has(value)) {
      return '[Circular]';
    }

    ancestors.add(value);
    try {
      if (value instanceof Date) {
        const timestamp = Date.prototype.getTime.call(value);
        return sensitive
          ? REDACTED
          : Number.isNaN(timestamp)
            ? null
            : new Date(timestamp).toISOString();
      }
      if (value instanceof URL) {
        return sensitive ? REDACTED : this.redactText(URL.prototype.toString.call(value));
      }
      if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
        // Binary material can contain a credential without its text representation.
        return REDACTED;
      }
      if (value instanceof Map) {
        return [...Map.prototype.entries.call(value)].map(([key, entry]: [unknown, unknown]) => [
          this.#visit(key, ancestors, sensitive, depth + 1),
          this.#visit(
            entry,
            ancestors,
            sensitive || (typeof key === 'string' && isSensitiveField(key)),
            depth + 1,
          ),
        ]);
      }
      if (value instanceof Set) {
        return [...Set.prototype.values.call(value)].map((entry: unknown) =>
          this.#visit(entry, ancestors, sensitive, depth + 1),
        );
      }

      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Array.isArray(value)) {
        const result: unknown[] = [];
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (descriptor === undefined) {
            result.length += 1;
          } else {
            const entry: unknown = descriptor.value;
            result.push(
              'value' in descriptor
                ? this.#visit(entry, ancestors, sensitive, depth + 1)
                : REDACTED,
            );
          }
        }
        return result;
      }

      const result: Record<string, unknown> = value instanceof Error ? { name: 'Error' } : {};
      for (const [key, descriptor] of Object.entries(descriptors)) {
        const errorDetail =
          value instanceof Error && ['name', 'message', 'stack', 'cause', 'errors'].includes(key);
        if (!descriptor.enumerable && !errorDetail) {
          continue;
        }
        const entry: unknown = descriptor.value;
        const scrubbed =
          'value' in descriptor
            ? this.#visit(entry, ancestors, sensitive || isSensitiveField(key), depth + 1)
            : REDACTED;
        // Defining a data property also neutralizes __proto__ and custom toJSON hooks.
        Object.defineProperty(result, this.redactText(key), {
          value: scrubbed,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return result;
    } catch {
      // Inspection can fail on proxies/accessors. Fail closed without echoing the object or error.
      return REDACTED;
    } finally {
      ancestors.delete(value);
    }
  }
}

export const secretRedactor = new SecretRedactor();
