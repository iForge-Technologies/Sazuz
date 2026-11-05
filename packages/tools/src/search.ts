import { z } from 'zod';
import { ToolError } from './errors.js';
import { fetchPublicText } from './network.js';
import type { ToolContext } from './registry.js';

export const searchResponseSchema = z.strictObject({
  source: z.string().min(1).max(200),
  results: z
    .array(
      z.strictObject({
        title: z.string().max(500),
        url: z
          .url()
          .max(4096)
          .refine((value) => {
            const url = new URL(value);
            return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
          }),
        snippet: z.string().max(4000),
      }),
    )
    .max(10),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

export interface SearchProvider {
  search(query: string, limit: number, context: ToolContext): Promise<SearchResponse>;
}

const wikipediaResponse = z.object({
  query: z.object({
    search: z
      .array(
        z.object({
          pageid: z.number().int().positive(),
          title: z.string().max(500),
          snippet: z.string().max(20_000),
        }),
      )
      .max(10),
  }),
});

function plainText(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(
      /&(?:amp|lt|gt|quot|#039);/g,
      (entity) =>
        ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#039;': "'" })[entity] ??
        entity,
    )
    .slice(0, 4000);
}

/** Official MediaWiki Action API. This is encyclopedia search, explicitly not a general web index. */
export const wikipediaSearch: SearchProvider = {
  async search(query, limit, context) {
    const url = new URL('https://en.wikipedia.org/w/api.php');
    url.search = new URLSearchParams({
      action: 'query',
      list: 'search',
      srsearch: query,
      srlimit: String(limit),
      format: 'json',
      utf8: '1',
    }).toString();
    const response = await fetchPublicText(url.toString(), context.signal, context.network);
    let body: unknown;
    try {
      body = JSON.parse(response.text) as unknown;
    } catch {
      throw new ToolError('INVALID_TOOL_RESULT');
    }
    const parsed = wikipediaResponse.safeParse(body);
    if (!parsed.success) throw new ToolError('INVALID_TOOL_RESULT');
    return {
      source: 'Wikipedia encyclopedia search (MediaWiki Action API)',
      results: parsed.data.query.search.slice(0, limit).map((item) => ({
        title: plainText(item.title),
        url: `https://en.wikipedia.org/?curid=${item.pageid}`,
        snippet: plainText(item.snippet),
      })),
    };
  },
};
