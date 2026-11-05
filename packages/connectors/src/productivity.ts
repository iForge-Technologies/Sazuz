import { z } from 'zod';
import type { ConnectorDependencies } from './contracts.js';
import { ConnectorError } from './errors.js';
import { optionPath, requiredOption } from './native-http.js';
import {
  boundedText,
  jsonList,
  jsonRecord,
  nativeAccount,
  nativeId,
  nativeLimit,
  nativeTool,
} from './native-tools.js';

export function createProductivityTools(dependencies: ConnectorDependencies) {
  return [
    nativeTool(dependencies, {
      provider: 'slack',
      permission: 'slack:read',
      name: 'slack.history',
      effect: 'read',
      description:
        'Read recent messages in the configured Slack channel through the official Web API.',
      input: nativeAccount.extend({ limit: nativeLimit }),
      response: z.object({
        ok: z.literal(true),
        messages: jsonList,
        has_more: z.boolean().optional(),
        response_metadata: jsonRecord.optional(),
      }),
      request: (_context, account, args, call) =>
        call(
          `https://slack.com/api/conversations.history?channel=${optionPath(account, 'channelId')}&limit=${args.limit}`,
        ),
    }),
    nativeTool(dependencies, {
      provider: 'slack',
      permission: 'slack:send',
      name: 'slack.send',
      effect: 'send',
      description: 'Send text to the configured Slack channel; unfurling is disabled.',
      input: nativeAccount.extend({ text: boundedText }),
      response: z.object({ ok: z.literal(true), channel: z.string(), ts: z.string() }),
      request: (_context, account, args, call) =>
        call('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          json: {
            channel: requiredOption(account, 'channelId'),
            text: args.text,
            unfurl_links: false,
            unfurl_media: false,
            parse: 'none',
          },
        }),
    }),
    nativeTool(dependencies, {
      provider: 'discord',
      permission: 'discord:read',
      name: 'discord.history',
      effect: 'read',
      description: 'Read recent messages in the configured Discord bot channel.',
      input: nativeAccount.extend({ limit: nativeLimit }),
      response: jsonList,
      request: (_context, account, args, call) =>
        call(
          `https://discord.com/api/v10/channels/${optionPath(account, 'channelId')}/messages?limit=${args.limit}`,
        ),
    }),
    nativeTool(dependencies, {
      provider: 'discord',
      permission: 'discord:send',
      name: 'discord.send',
      effect: 'send',
      description: 'Send text in the configured Discord bot channel without automatic mentions.',
      input: nativeAccount.extend({ text: z.string().min(1).max(2000) }),
      response: z.object({ id: z.string(), channel_id: z.string(), content: z.string() }),
      request: (_context, account, args, call) =>
        call(`https://discord.com/api/v10/channels/${optionPath(account, 'channelId')}/messages`, {
          method: 'POST',
          json: { content: args.text, allowed_mentions: { parse: [] } },
        }),
    }),
    nativeTool(dependencies, {
      provider: 'notion',
      permission: 'notion:read',
      name: 'notion.read',
      effect: 'read',
      description: 'Read blocks on the single configured Notion page.',
      input: nativeAccount.extend({ limit: nativeLimit }),
      response: z.object({
        results: jsonList,
        has_more: z.boolean(),
        next_cursor: z.string().nullable(),
      }),
      request: (_context, account, args, call) =>
        call(
          `https://api.notion.com/v1/blocks/${optionPath(account, 'pageId')}/children?page_size=${args.limit}`,
        ),
    }),
    nativeTool(dependencies, {
      provider: 'notion',
      permission: 'notion:read',
      name: 'notion.query',
      effect: 'read',
      description: 'Query the configured Notion data source.',
      input: nativeAccount.extend({ limit: nativeLimit }),
      response: z.object({
        results: jsonList,
        has_more: z.boolean(),
        next_cursor: z.string().nullable(),
      }),
      request: (_context, account, args, call) =>
        call(
          `https://api.notion.com/v1/data_sources/${optionPath(account, 'dataSourceId')}/query`,
          { method: 'POST', json: { page_size: args.limit } },
        ),
    }),
    nativeTool(dependencies, {
      provider: 'notion',
      permission: 'notion:write',
      name: 'notion.append',
      effect: 'write',
      description: 'Append a text paragraph to the configured Notion page.',
      input: nativeAccount.extend({ text: z.string().min(1).max(2000) }),
      response: z.object({ results: jsonList }),
      request: (_context, account, args, call) =>
        call(`https://api.notion.com/v1/blocks/${optionPath(account, 'pageId')}/children`, {
          method: 'PATCH',
          json: {
            children: [
              {
                object: 'block',
                type: 'paragraph',
                paragraph: { rich_text: [{ type: 'text', text: { content: args.text } }] },
              },
            ],
          },
        }),
    }),
    nativeTool(dependencies, {
      provider: 'todoist',
      permission: 'todoist:read',
      name: 'todoist.list',
      effect: 'read',
      description: 'List active tasks in the configured Todoist project using API v1.',
      input: nativeAccount.extend({ limit: nativeLimit }),
      response: z.object({ results: jsonList, next_cursor: z.string().nullable() }),
      request: (_context, account, args, call) =>
        call(
          `https://api.todoist.com/api/v1/tasks?project_id=${optionPath(account, 'projectId')}&limit=${args.limit}`,
        ),
    }),
    nativeTool(dependencies, {
      provider: 'todoist',
      permission: 'todoist:write',
      name: 'todoist.create',
      effect: 'write',
      description: 'Create a task in the configured Todoist project.',
      input: nativeAccount.extend({
        content: z.string().min(1).max(500),
        description: z.string().max(4000).default(''),
      }),
      response: z.object({ id: z.string(), project_id: z.string(), content: z.string() }),
      request: (_context, account, args, call) =>
        call('https://api.todoist.com/api/v1/tasks', {
          method: 'POST',
          json: {
            project_id: requiredOption(account, 'projectId'),
            content: args.content,
            description: args.description,
          },
        }),
    }),
    nativeTool(dependencies, {
      provider: 'todoist',
      permission: 'todoist:write',
      name: 'todoist.close',
      effect: 'write',
      description:
        'Complete a task after checking that it belongs to the configured Todoist project.',
      input: nativeAccount.extend({ taskId: nativeId }),
      response: z.union([z.null(), jsonRecord]),
      request: async (_context, account, args, call) => {
        const url = `https://api.todoist.com/api/v1/tasks/${encodeURIComponent(args.taskId)}`;
        const task = z.object({ project_id: z.string() }).parse(await call(url));
        if (task.project_id !== requiredOption(account, 'projectId'))
          throw new ConnectorError('ACCOUNT_SCOPE_DENIED');
        return call(`${url}/close`, { method: 'POST' });
      },
    }),
    nativeTool(dependencies, {
      provider: 'linear',
      permission: 'linear:read',
      name: 'linear.list',
      effect: 'read',
      description: 'Read issues belonging to the configured Linear team.',
      input: nativeAccount.extend({ limit: nativeLimit }),
      response: z.object({ data: z.object({ issues: jsonRecord }), errors: z.never().optional() }),
      request: (_context, account, args, call) =>
        call('https://api.linear.app/graphql', {
          method: 'POST',
          json: {
            query:
              'query SazuzIssues($team: ID!, $first: Int!) { issues(filter: {team: {id: {eq: $team}}}, first: $first) { nodes { id identifier title url } pageInfo { hasNextPage endCursor } } }',
            variables: { team: requiredOption(account, 'teamId'), first: args.limit },
          },
        }),
    }),
    nativeTool(dependencies, {
      provider: 'linear',
      permission: 'linear:write',
      name: 'linear.create',
      effect: 'write',
      description: 'Create an issue in the configured Linear team.',
      input: nativeAccount.extend({
        title: z.string().min(1).max(500),
        description: z.string().max(10000).default(''),
      }),
      response: z.object({
        data: z.object({ issueCreate: z.object({ success: z.literal(true), issue: jsonRecord }) }),
        errors: z.never().optional(),
      }),
      request: (_context, account, args, call) =>
        call('https://api.linear.app/graphql', {
          method: 'POST',
          json: {
            query:
              'mutation SazuzCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier title url } } }',
            variables: {
              input: {
                teamId: requiredOption(account, 'teamId'),
                title: args.title,
                description: args.description,
              },
            },
          },
        }),
    }),
    nativeTool(dependencies, {
      provider: 'jira',
      permission: 'jira:read',
      name: 'jira.list',
      effect: 'read',
      description: 'List issues in the configured Jira project using the official v3 search API.',
      input: nativeAccount.extend({ limit: nativeLimit }),
      response: z.object({
        issues: jsonList,
        nextPageToken: z.string().optional(),
        isLast: z.boolean().optional(),
      }),
      request: (_context, account, args, call) =>
        call(
          `${requiredOption(account, 'baseUrl').replace(/\/$/, '')}/rest/api/3/search/jql?${new URLSearchParams({ jql: `project = ${requiredOption(account, 'projectKey')} ORDER BY created DESC`, maxResults: String(args.limit), fields: 'summary,status,description' }).toString()}`,
          { custom: true },
        ),
    }),
    nativeTool(dependencies, {
      provider: 'jira',
      permission: 'jira:write',
      name: 'jira.create',
      effect: 'write',
      description: 'Create a task in the configured Jira project.',
      input: nativeAccount.extend({ summary: z.string().min(1).max(255), text: boundedText }),
      response: z.object({ id: z.string(), key: z.string(), self: z.string() }),
      request: (_context, account, args, call) =>
        call(`${requiredOption(account, 'baseUrl').replace(/\/$/, '')}/rest/api/3/issue`, {
          custom: true,
          method: 'POST',
          json: {
            fields: {
              project: { key: requiredOption(account, 'projectKey') },
              issuetype: { name: account.options.issueType ?? 'Task' },
              summary: args.summary,
              description: {
                type: 'doc',
                version: 1,
                content: [{ type: 'paragraph', content: [{ type: 'text', text: args.text }] }],
              },
            },
          },
        }),
    }),
    nativeTool(dependencies, {
      provider: 'stripe',
      permission: 'stripe:read',
      name: 'stripe.balance',
      effect: 'read',
      description:
        'Read the Stripe balance using a restricted read-only key; no money movement tools exist.',
      input: nativeAccount,
      response: z.object({ object: z.literal('balance'), available: jsonList, pending: jsonList }),
      request: (_context, _account, _args, call) => call('https://api.stripe.com/v1/balance'),
    }),
    nativeTool(dependencies, {
      provider: 'stripe',
      permission: 'stripe:read',
      name: 'stripe.invoices',
      effect: 'read',
      description: 'List invoices through Stripe’s read-only API surface.',
      input: nativeAccount.extend({ limit: nativeLimit }),
      response: z.object({ object: z.literal('list'), data: jsonList, has_more: z.boolean() }),
      request: (_context, _account, args, call) =>
        call(`https://api.stripe.com/v1/invoices?limit=${args.limit}`),
    }),
    nativeTool(dependencies, {
      provider: 'webhook',
      permission: 'webhook:send',
      name: 'webhook.send',
      effect: 'send',
      description:
        'POST a bounded JSON event to the single configured HTTPS webhook; redirects are refused.',
      input: nativeAccount.extend({ event: z.string().min(1).max(120), payload: jsonRecord }),
      response: z.union([z.null(), jsonRecord]),
      request: (context, account, args, call) =>
        call(requiredOption(account, 'baseUrl'), {
          custom: true,
          method: 'POST',
          json: { event: args.event, payload: args.payload },
          headers: { 'idempotency-key': context.idempotencyKey },
        }),
    }),
  ];
}
