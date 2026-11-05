import { createHash } from 'node:crypto';
import { fetchPublicText, type SafeNetworkDependencies } from '@sazuz/tools';
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import { rssTriggerConfigSchema, triggerIdSchema, type TriggerCandidate } from './contracts.js';
import { TriggerError } from './errors.js';
import { triggerEventKey } from './events.js';

export const FEED_MAX_BYTES = 262_144;
export const FEED_MAX_ITEMS = 200;
export const feedItemSchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  sourceId: z.string().min(1).max(16_384),
  title: z.string().max(1000),
  url: z.url().max(4096).nullable(),
  summary: z.string().max(16_384),
  publishedAt: z.iso.datetime().nullable(),
});
export type FeedItem = z.infer<typeof feedItemSchema>;
const feedDocumentSchema = z.strictObject({
  url: rssTriggerConfigSchema.shape.url,
  baseUrl: rssTriggerConfigSchema.shape.url.optional(),
  xml: z.string(),
});
const recordSchema = z.record(z.string(), z.unknown());

function record(value: unknown): Record<string, unknown> {
  const result = recordSchema.safeParse(value);
  if (!result.success) throw new TriggerError('INVALID_FEED');
  return result.data;
}

function values(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function scalar(value: unknown): string {
  if (typeof value === 'string') return value.trim().normalize('NFC');
  if (value === undefined) return '';
  const object = record(value);
  return typeof object['#text'] === 'string' ? object['#text'].trim().normalize('NFC') : '';
}

function normalizedUrl(value: string, base?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    const normalized = url.toString();
    return normalized.length <= 4096 ? normalized : null;
  } catch {
    return null;
  }
}

function publishedAt(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function link(value: unknown, base: string): string | null {
  for (const entry of values(value)) {
    if (typeof entry === 'string') {
      const url = normalizedUrl(entry.trim(), base);
      if (url !== null) return url;
    } else {
      const candidate = record(entry);
      const relationship = scalar(candidate['@_rel']);
      if (relationship !== '' && relationship !== 'alternate') continue;
      const url = normalizedUrl(scalar(candidate['@_href']) || scalar(candidate['#text']), base);
      if (url !== null) return url;
    }
  }
  return null;
}

/** Prefer stable publisher identity, then canonical link, then a deterministic content fingerprint. */
export function normalizeFeedItemId(input: {
  feedUrl: string;
  sourceId?: string;
  url?: string | null;
  title: string;
  summary: string;
  publishedAt: string | null;
}): { id: string; sourceId: string } {
  const parsed = z
    .strictObject({
      feedUrl: rssTriggerConfigSchema.shape.url,
      sourceId: z.string().max(16_384).optional(),
      url: z.string().max(4096).nullable().optional(),
      title: feedItemSchema.shape.title,
      summary: feedItemSchema.shape.summary,
      publishedAt: feedItemSchema.shape.publishedAt,
    })
    .safeParse(input);
  if (!parsed.success) throw new TriggerError('INVALID_FEED');
  const item = parsed.data;
  const explicitId = item.sourceId?.trim().normalize('NFC');
  const sourceId = explicitId
    ? (normalizedUrl(explicitId) ?? explicitId)
    : item.url
      ? (normalizedUrl(item.url) ?? item.url)
      : createHash('sha256')
          .update(JSON.stringify([item.title, item.summary, item.publishedAt]))
          .digest('hex');
  const id = createHash('sha256')
    .update(JSON.stringify(['sazuz.feed.v1', normalizedUrl(item.feedUrl), sourceId]))
    .digest('hex');
  return { id, sourceId };
}

/** No DTD, custom entity, network resolution, HTML execution, or unbounded nesting. */
export function parseFeed(input: { xml: string; url: string; baseUrl?: string }): FeedItem[] {
  const parsedInput = feedDocumentSchema.safeParse(input);
  if (!parsedInput.success) throw new TriggerError('INVALID_FEED');
  const { xml, url } = parsedInput.data;
  if (Buffer.byteLength(xml, 'utf8') > FEED_MAX_BYTES) throw new TriggerError('FEED_TOO_LARGE');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new TriggerError('INVALID_FEED');
  const markup = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  for (const match of markup.matchAll(/&([A-Za-z_][A-Za-z0-9_.:-]*);/g)) {
    if (!['amp', 'lt', 'gt', 'quot', 'apos'].includes(match[1]!))
      throw new TriggerError('INVALID_FEED');
  }
  let document: Record<string, unknown>;
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      removeNSPrefix: true,
      parseTagValue: false,
      parseAttributeValue: false,
      ignoreDeclaration: true,
      ignorePiTags: true,
      maxNestedTags: 32,
      // Only predefined XML escapes remain after declarations/custom references are rejected.
      processEntities: { maxEntityCount: 0, maxExpandedLength: FEED_MAX_BYTES },
      htmlEntities: false,
    });
    const data: unknown = parser.parse(xml, true);
    document = record(data);
  } catch {
    throw new TriggerError('INVALID_FEED');
  }
  const roots = ['rss', 'feed', 'RDF'].filter((root) => document[root] !== undefined);
  if (roots.length !== 1 || Object.keys(document).length !== 1)
    throw new TriggerError('INVALID_FEED');
  const root = roots[0]!;
  const container = record(document[root]);
  const entries = values(
    root === 'rss'
      ? record(container.channel).item
      : root === 'feed'
        ? container.entry
        : container.item,
  );
  if (entries.length > FEED_MAX_ITEMS) throw new TriggerError('FEED_TOO_LARGE');
  const unique = new Map<string, FeedItem>();
  for (const entry of entries) {
    const item = record(entry);
    const title = scalar(item.title);
    const summary = scalar(item.description ?? item.summary ?? item.content ?? item.encoded);
    const itemUrl = link(item.link, parsedInput.data.baseUrl ?? url);
    const date = publishedAt(scalar(item.pubDate ?? item.published ?? item.updated ?? item.date));
    const sourceId = scalar(item.guid ?? item.id);
    if (!title && !summary && !sourceId && itemUrl === null) throw new TriggerError('INVALID_FEED');
    const identity = normalizeFeedItemId({
      feedUrl: url,
      sourceId,
      url: itemUrl,
      title,
      summary,
      publishedAt: date,
    });
    const normalized = feedItemSchema.safeParse({
      ...identity,
      title,
      summary,
      url: itemUrl,
      publishedAt: date,
    });
    if (!normalized.success) throw new TriggerError('INVALID_FEED');
    if (!unique.has(identity.id)) unique.set(identity.id, normalized.data);
  }
  return [...unique.values()];
}

export async function fetchRssFeed(
  url: string,
  signal: AbortSignal,
  network: SafeNetworkDependencies = {},
): Promise<FeedItem[]> {
  let response;
  try {
    response = await fetchPublicText(url, signal, {
      ...network,
      maxResponseBytes: Math.min(network.maxResponseBytes ?? FEED_MAX_BYTES, FEED_MAX_BYTES),
    });
  } catch {
    throw new TriggerError(signal.aborted ? 'POLL_ABORTED' : 'FEED_FETCH_FAILED');
  }
  return parseFeed({ xml: response.text, url, baseUrl: response.url });
}

/** Database uniqueness is authoritative; seen keys only avoid redundant candidate work. */
export function rssTriggerCandidates(input: {
  triggerId: string;
  items: readonly FeedItem[];
  now: Date;
  seenDedupeKeys?: readonly string[];
}): TriggerCandidate[] {
  const parsed = z
    .strictObject({
      triggerId: triggerIdSchema,
      items: z.array(feedItemSchema).max(FEED_MAX_ITEMS),
      now: z.date(),
      seenDedupeKeys: z
        .array(z.string().regex(/^[a-f0-9]{64}$/))
        .max(10_000)
        .default([]),
    })
    .safeParse(input);
  if (!parsed.success) throw new TriggerError('INVALID_TRIGGER');
  const seen = new Set(parsed.data.seenDedupeKeys);
  const candidates: TriggerCandidate[] = [];
  for (const item of parsed.data.items) {
    const dedupeKey = triggerEventKey(parsed.data.triggerId, 'rss', item.id);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    candidates.push({
      triggerId: parsed.data.triggerId,
      kind: 'rss',
      dedupeKey,
      occurredAt: item.publishedAt ?? parsed.data.now.toISOString(),
      untrusted: true,
      payload: { ...item },
    });
  }
  return candidates;
}
