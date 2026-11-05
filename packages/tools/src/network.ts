import { lookup as resolveDns } from 'node:dns/promises';
import { request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { z } from 'zod';
import { checkAbort, ToolError } from './errors.js';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface SafeNetworkRequest {
  url: URL;
  address: ResolvedAddress;
  signal: AbortSignal;
  maxBytes: number;
  headers: Readonly<Record<string, string>>;
}

export interface SafeNetworkResponse {
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  body: string;
}

/** Optional transports are trusted server dependencies, never model-controlled arguments. */
export interface SafeNetworkDependencies {
  lookup?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  request?: (request: SafeNetworkRequest) => Promise<SafeNetworkResponse>;
  allowedHosts?: readonly string[];
  maxResponseBytes?: number;
  timeoutMs?: number;
}

export interface FetchedText {
  url: string;
  status: number;
  contentType: string;
  text: string;
}

const defaultMaxBytes = 262_144;
const maxRedirects = 5;
const resolvedAddressSchema = z.strictObject({
  address: z.string(),
  family: z.union([z.literal(4), z.literal(6)]),
});
const responseSchema = z.strictObject({
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string(), z.string().optional()),
  body: z.string(),
});

function ipv4Number(address: string): number {
  return address.split('.').reduce((result, part) => result * 256 + Number(part), 0);
}

function inV4Range(address: number, base: string, bits: number): boolean {
  const span = 2 ** (32 - bits);
  return Math.floor(address / span) === Math.floor(ipv4Number(base) / span);
}

function ipv6Number(address: string): bigint | undefined {
  const sections = address.toLowerCase().split('::');
  if (sections.length > 2) return undefined;
  const decode = (section: string): string[] => {
    if (!section) return [];
    return section.split(':').flatMap((part) => {
      if (!part.includes('.')) return [part];
      const ipv4 = ipv4Number(part);
      return [Math.floor(ipv4 / 65_536).toString(16), (ipv4 % 65_536).toString(16)];
    });
  };
  const left = decode(sections[0] ?? '');
  const right = decode(sections[1] ?? '');
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (sections.length === 1 && missing !== 0)) return undefined;
  const words = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  return words.reduce((result, part) => (result << 16n) + BigInt(`0x${part}`), 0n);
}

/** Permit globally routable unicast only; special-use, metadata and transition ranges are denied. */
export function isPublicAddress(raw: string): boolean {
  const address = raw.replace(/^\[|\]$/g, '');
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    const blocked: readonly [string, number][] = [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.88.99.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ];
    return (
      address !== '168.63.129.16' && !blocked.some(([base, bits]) => inV4Range(value, base, bits))
    );
  }
  if (family === 6) {
    const value = ipv6Number(address);
    if (value === undefined || value >> 125n !== 1n) return false;
    const excluded: readonly [bigint, bigint][] = [
      [0x20010000000000000000000000000000n, 23n],
      [0x20010db8000000000000000000000000n, 32n],
      [0x20020000000000000000000000000000n, 16n],
      [0x3fff0000000000000000000000000000n, 20n],
    ];
    return !excluded.some(([base, bits]) => value >> (128n - bits) === base >> (128n - bits));
  }
  return false;
}

function parsedPublicUrl(value: string, allowedHosts?: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ToolError('UNSAFE_URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    value.length > 4096 ||
    (url.port !== '' && !['80', '443'].includes(url.port))
  )
    throw new ToolError('UNSAFE_URL');
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (
    !hostname ||
    hostname === 'localhost' ||
    (!hostname.includes('.') && isIP(hostname) === 0) ||
    /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid)$/.test(hostname) ||
    hostname === 'metadata.google.internal' ||
    (isIP(hostname) !== 0 && !isPublicAddress(hostname))
  )
    throw new ToolError('UNSAFE_URL');
  if (
    allowedHosts !== undefined &&
    !allowedHosts.some((host) => host.toLowerCase().replace(/\.$/, '') === hostname)
  ) {
    throw new ToolError('UNSAFE_URL');
  }
  return url;
}

export async function resolvePublicUrl(
  value: string,
  dependencies: SafeNetworkDependencies = {},
): Promise<{ url: URL; address: ResolvedAddress }> {
  const url = parsedPublicUrl(value, dependencies.allowedHosts);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6)
    return { url, address: { address: hostname, family: literalFamily } };
  let addresses: readonly ResolvedAddress[];
  try {
    const lookup =
      dependencies.lookup ??
      (async (host: string) => {
        const results = await resolveDns(host, { all: true, verbatim: true });
        return results.map((result) => resolvedAddressSchema.parse(result));
      });
    addresses = await lookup(hostname);
  } catch {
    throw new ToolError('NETWORK_FAILED');
  }
  if (
    !addresses.length ||
    addresses.length > 64 ||
    addresses.some(
      (item) =>
        !resolvedAddressSchema.safeParse(item).success ||
        isIP(item.address) !== item.family ||
        !isPublicAddress(item.address),
    )
  ) {
    throw new ToolError('UNSAFE_URL');
  }
  return { url, address: addresses[0]! };
}

function transport(request: SafeNetworkRequest): Promise<SafeNetworkResponse> {
  return new Promise((resolve, reject) => {
    checkAbort(request.signal);
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [request.address]);
      else callback(null, request.address.address, request.address.family);
    };
    const sender = request.url.protocol === 'https:' ? requestHttps : requestHttp;
    const outbound = sender(
      request.url,
      {
        method: 'GET',
        agent: false,
        lookup,
        signal: request.signal,
        headers: request.headers,
      },
      (response) => {
        const length = response.headers['content-length'];
        if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > request.maxBytes)) {
          response.destroy();
          reject(new ToolError('RESPONSE_TOO_LARGE'));
          return;
        }
        const encoding = response.headers['content-encoding'];
        if (encoding !== undefined && encoding.toLowerCase() !== 'identity') {
          response.destroy();
          reject(new ToolError('UNSUPPORTED_CONTENT'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > request.maxBytes) {
            response.destroy();
            reject(new ToolError('RESPONSE_TOO_LARGE'));
          } else chunks.push(chunk);
        });
        response.once('error', () => reject(new ToolError('NETWORK_FAILED')));
        response.once('aborted', () => reject(new ToolError('NETWORK_FAILED')));
        response.once('end', () =>
          resolve({
            status: response.statusCode ?? 502,
            headers: {
              'content-type': response.headers['content-type'],
              location: response.headers.location,
            },
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    outbound.once('error', () =>
      reject(new ToolError(request.signal.aborted ? 'TOOL_ABORTED' : 'NETWORK_FAILED')),
    );
    outbound.end();
  });
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  checkAbort(signal);
  let listener: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        listener = () => reject(new ToolError('TOOL_ABORTED'));
        signal.addEventListener('abort', listener, { once: true });
      }),
    ]);
  } finally {
    if (listener !== undefined) signal.removeEventListener('abort', listener);
  }
}

/** Re-resolve and revalidate every redirect, then connect only to the selected checked address. */
export async function fetchPublicText(
  value: string,
  signal: AbortSignal,
  dependencies: SafeNetworkDependencies = {},
): Promise<FetchedText> {
  const maxBytes = z
    .number()
    .int()
    .min(1)
    .max(1_048_576)
    .safeParse(dependencies.maxResponseBytes ?? defaultMaxBytes);
  const timeout = z
    .number()
    .int()
    .min(1)
    .max(60_000)
    .safeParse(dependencies.timeoutMs ?? 15_000);
  if (!maxBytes.success || !timeout.success) throw new ToolError('UNSAFE_URL');
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(timeout.data)]);
  let current = value;
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    checkAbort(boundedSignal);
    const resolved = await abortable(resolvePublicUrl(current, dependencies), boundedSignal);
    checkAbort(boundedSignal);
    let response: SafeNetworkResponse;
    try {
      const received = await abortable(
        (dependencies.request ?? transport)({
          ...resolved,
          signal: boundedSignal,
          maxBytes: maxBytes.data,
          headers: {
            'user-agent': 'Sazuz/1.0 (self-hosted assistant)',
            accept:
              'text/*, application/json, application/xml, application/xhtml+xml, application/rss+xml, application/atom+xml',
            'accept-encoding': 'identity',
          },
        }),
        boundedSignal,
      );
      const parsed = responseSchema.safeParse(received);
      if (!parsed.success) throw new ToolError('NETWORK_FAILED');
      response = parsed.data;
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError(boundedSignal.aborted ? 'TOOL_ABORTED' : 'NETWORK_FAILED');
    }
    if (Buffer.byteLength(response.body, 'utf8') > maxBytes.data)
      throw new ToolError('RESPONSE_TOO_LARGE');
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === maxRedirects) throw new ToolError('TOO_MANY_REDIRECTS');
      const location = response.headers.location;
      if (location === undefined) throw new ToolError('NETWORK_FAILED');
      try {
        current = new URL(location, resolved.url).toString();
      } catch {
        throw new ToolError('UNSAFE_URL');
      }
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new ToolError('NETWORK_FAILED');
    const contentType = (response.headers['content-type'] ?? 'text/plain')
      .split(';')[0]!
      .trim()
      .toLowerCase();
    if (
      !contentType.startsWith('text/') &&
      ![
        'application/json',
        'application/xml',
        'application/xhtml+xml',
        'application/rss+xml',
        'application/atom+xml',
      ].includes(contentType)
    ) {
      throw new ToolError('UNSUPPORTED_CONTENT');
    }
    return {
      url: resolved.url.toString(),
      status: response.status,
      contentType,
      text: response.body,
    };
  }
  throw new ToolError('TOO_MANY_REDIRECTS');
}
