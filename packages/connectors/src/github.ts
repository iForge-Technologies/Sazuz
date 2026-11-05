import type { RegisteredTool, ToolContext } from '@sazuz/tools';
import { z } from 'zod';
import type { ConnectorAccount, ConnectorDependencies } from './contracts.js';
import { ConnectorError } from './errors.js';
import { parseResponse, requestJson, requireSuccess } from './http.js';
import {
  accountInput,
  assertAccountPermission,
  assertOutbound,
  defineAccountTool,
  operationMarker,
  useSecret,
} from './sdk.js';

const issueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().max(10000),
  body: z.string().max(100000).nullable(),
  state: z.enum(['open', 'closed']),
  html_url: z.url().max(2048),
  user: z
    .object({ login: z.string().max(200) })
    .nullable()
    .optional(),
  pull_request: z.unknown().optional(),
});
const pullSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().max(10000),
  body: z.string().max(100000).nullable(),
  state: z.enum(['open', 'closed']),
  html_url: z.url().max(2048),
  head: z.object({ ref: z.string().max(300), label: z.string().max(500).optional() }),
  base: z.object({ ref: z.string().max(300) }),
});

function repoPath(account: ConnectorAccount): string {
  if (account.options.repo === undefined) throw new ConnectorError('ACCOUNT_UNAVAILABLE');
  return account.options.repo.split('/').map(encodeURIComponent).join('/');
}

async function githubRequest(
  account: ConnectorAccount,
  context: ToolContext,
  dependencies: ConnectorDependencies,
  suffix: string,
  args: unknown,
  init: RequestInit = {},
): Promise<unknown> {
  return useSecret(context, account.secretRef, async (access) => {
    assertOutbound(context, args);
    const result = await requestJson(
      new URL(`https://api.github.com/repos/${repoPath(account)}${suffix}`),
      {
        ...init,
        headers: {
          authorization: `Bearer ${access}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'Sazuz',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
      },
      context.signal,
      dependencies.fetch,
    );
    requireSuccess(result.status);
    return result.body;
  });
}

export function createGitHubTools(dependencies: ConnectorDependencies): RegisteredTool[] {
  const common = { provider: 'github', roles: ['chief-of-staff', 'researcher', 'coder'] } as const;
  return [
    defineAccountTool(dependencies, {
      ...common,
      name: 'github.list_issues',
      description: 'List issues for the repository explicitly configured on this account.',
      effect: 'read',
      permission: 'github:read',
      input: accountInput.extend({
        state: z.enum(['open', 'closed', 'all']).default('open'),
        limit: z.number().int().min(1).max(100).default(20),
        page: z.number().int().min(1).max(1000).default(1),
      }),
      output: z.strictObject({ issues: z.array(issueSchema).max(100) }),
      run: async (context, account, args) => {
        const query = new URLSearchParams({
          state: args.state,
          per_page: String(args.limit),
          page: String(args.page),
        });
        const issues = parseResponse(
          await githubRequest(account, context, dependencies, `/issues?${query.toString()}`, args),
          z.array(issueSchema).max(100),
        );
        return { issues: issues.filter((issue) => issue.pull_request === undefined) };
      },
    }),
    defineAccountTool(dependencies, {
      ...common,
      name: 'github.read_issue',
      description: 'Read one issue from this account’s configured GitHub repository.',
      effect: 'read',
      permission: 'github:read',
      input: accountInput.extend({ number: z.number().int().positive().max(2147483647) }),
      output: issueSchema,
      run: async (context, account, args) =>
        parseResponse(
          await githubRequest(account, context, dependencies, `/issues/${args.number}`, args),
          issueSchema,
        ),
    }),
    defineAccountTool(dependencies, {
      ...common,
      roles: ['chief-of-staff', 'coder'],
      name: 'github.create_pull_request',
      description:
        'Create a draft pull request in the configured repository using existing branches and a stable operation marker.',
      effect: 'write',
      permission: 'github:write',
      input: accountInput.extend({
        head: z
          .string()
          .min(1)
          .max(300)
          .regex(/^[A-Za-z0-9_./:-]+$/),
        base: z
          .string()
          .min(1)
          .max(300)
          .regex(/^[A-Za-z0-9_./-]+$/),
        title: z.string().min(1).max(256),
        body: z.string().max(60000).default(''),
        draft: z.boolean().default(true),
      }),
      output: pullSchema,
      run: async (context, account, args) => {
        const marker = `<!-- sazuz:${operationMarker(context, account.id)} -->`;
        return parseResponse(
          await githubRequest(account, context, dependencies, '/pulls', args, {
            method: 'POST',
            body: JSON.stringify({
              head: args.head,
              base: args.base,
              title: args.title,
              body: `${args.body}\n\n${marker}`,
              draft: args.draft,
            }),
          }),
          pullSchema,
        );
      },
      verify: async (context, account, args) => {
        try {
          assertAccountPermission(account, 'github', 'github:read');
        } catch (error) {
          if (error instanceof ConnectorError && error.connectorCode === 'ACCOUNT_SCOPE_DENIED')
            return { status: 'unknown' };
          throw error;
        }
        const repo = account.options.repo;
        if (repo === undefined) throw new ConnectorError('ACCOUNT_UNAVAILABLE');
        const head = args.head.includes(':') ? args.head : `${repo.split('/')[0]!}:${args.head}`;
        const query = new URLSearchParams({ state: 'all', head, base: args.base, per_page: '100' });
        const pulls = parseResponse(
          await githubRequest(account, context, dependencies, `/pulls?${query.toString()}`, args),
          z.array(pullSchema).max(100),
        );
        const marker = `<!-- sazuz:${operationMarker(context, account.id)} -->`;
        const matches = pulls.filter(
          (pull) =>
            pull.body?.includes(marker) &&
            pull.base.ref === args.base &&
            (pull.head.label === head || pull.head.ref === args.head),
        );
        return matches.length === 1
          ? { status: 'done', result: matches[0]! }
          : { status: 'unknown' };
      },
    }),
  ];
}
