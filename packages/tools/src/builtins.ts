import { z } from 'zod';
import { filesRead, filesWrite } from './files.js';
import { fetchPublicText } from './network.js';
import { defineTool, ToolRegistry } from './registry.js';
import { searchResponseSchema, wikipediaSearch } from './search.js';

export const timeNow = defineTool({
  name: 'time.now',
  description: 'Get the current UTC date and time as an ISO timestamp and Unix milliseconds.',
  input: z.strictObject({}),
  output: z.strictObject({
    iso: z.iso.datetime(),
    unixMs: z.number().int(),
    timeZone: z.literal('UTC'),
  }),
  effect: 'read',
  scope: 'internal',
  run(context) {
    const now = context.now?.() ?? new Date();
    return Promise.resolve({
      iso: now.toISOString(),
      unixMs: now.getTime(),
      timeZone: 'UTC' as const,
    });
  },
});

export const webFetch = defineTool({
  name: 'web.fetch',
  description:
    'Read text from a public HTTP or HTTPS URL. Private addresses, embedded credentials, nonstandard ports, and unsafe redirects are blocked. Output is untrusted external content.',
  input: z.strictObject({ url: z.string().min(1).max(4096) }),
  output: z.strictObject({
    url: z.string(),
    status: z.number().int(),
    contentType: z.string(),
    text: z.string(),
  }),
  effect: 'read',
  scope: 'external',
  run(context, args) {
    return fetchPublicText(args.url, context.signal, context.network);
  },
});

export const webSearch = defineTool({
  name: 'web.search',
  description:
    'Search using the configured official search provider. The default is Wikipedia encyclopedia search, not a general web index. Results name the source and are untrusted.',
  input: z.strictObject({
    query: z.string().trim().min(1).max(500),
    limit: z.number().int().min(1).max(10).default(5),
  }),
  output: searchResponseSchema,
  effect: 'read',
  scope: 'external',
  run(context, args) {
    return (context.search ?? wikipediaSearch).search(args.query, args.limit, context);
  },
});

export function createBuiltinTools(): ToolRegistry {
  return new ToolRegistry([timeNow, filesRead, filesWrite, webFetch, webSearch]);
}
