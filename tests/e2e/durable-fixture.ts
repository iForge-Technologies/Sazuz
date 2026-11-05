import type { Page } from '@playwright/test';
import { z } from 'zod';
import { freshSettings, settingsSchemas } from '@sazuz/config/settings';
import { projectReviewSchema } from '@sazuz/core/reviews';
import {
  approvalDecisionSchema,
  approvalSchema,
  controlInputSchema,
  controlSchema,
  missionInputSchema,
  missionSchema,
  runControlSchema,
  schedulePreviewInputSchema,
  telegramPairInputSchema,
  triggerInputSchema,
  triggerSchema,
  triggerUpdateSchema,
  type Approval,
  type Mission,
  type Run,
  type Trigger,
} from '@sazuz/core/missions';

export const fixtureId = (prefix: string, digit = '1') => `${prefix}_${'0'.repeat(25)}${digit}`;
export const projectId = fixtureId('prj');
export const missionId = fixtureId('mis');
export const runId = fixtureId('run');
export const approvalId = fixtureId('apr');
export const triggerId = fixtureId('trg');
export const stamp = '2026-11-03T12:00:00.000Z';
const future = '2030-11-03T12:00:00.000Z';

export function fixtureMission(status: Run['status'] = 'waiting_approval'): Mission {
  return missionSchema.parse({
    id: missionId,
    projectId,
    threadId: fixtureId('thr'),
    title: 'Prepare the weekly update',
    goal: 'Review project progress and send the agreed update.',
    agent: 'cos',
    createdAt: stamp,
    updatedAt: stamp,
    run: {
      id: runId,
      missionId,
      agentId: 'comms',
      status,
      step: 4,
      costUsd: 0.5,
      limits: { maxSteps: 10, maxCostUsd: 0.5, maxWallTimeSeconds: 300 },
      tainted: false,
      reason: status === 'budget_exceeded' ? 'The run reached its cost allowance.' : null,
      version: 3,
      createdAt: stamp,
      updatedAt: stamp,
    },
  });
}

export function fixtureApproval(overrides: Partial<Approval> = {}): Approval {
  return approvalSchema.parse({
    id: approvalId,
    runId,
    missionId,
    projectId,
    agentId: 'comms',
    toolName: 'gmail.send',
    args: {
      accountId: 'work-mail',
      to: ['reviewer@example.com'],
      cc: [],
      subject: 'Weekly update',
      text: 'The release is ready for review.',
    },
    effect: 'send',
    reason: 'Send the project update to the agreed reviewer.',
    risk: 'medium',
    ruleId: 'preset:balanced:send:external',
    tainted: false,
    kind: 'policy',
    status: 'pending',
    version: 2,
    expiresAt: future,
    createdAt: stamp,
    note: null,
    ...overrides,
  });
}

export async function mockDurableWorkspace(
  page: Page,
  options: {
    empty?: boolean;
    status?: Run['status'];
    approval?: Partial<Approval>;
    malformedPreview?: boolean;
    failFirstMission?: boolean;
  } = {},
) {
  const settings = freshSettings();
  settings.general.value.timezone = 'Asia/Kolkata';
  settings.security.version = 4;
  settings.security.value.rules = [
    {
      id: 'retain-existing-deny',
      scope: { type: 'global' },
      match: { effect: 'spend' },
      when: [],
      action: 'deny',
    },
  ];
  settings.channels.value.telegramSecretRef = `secret://${fixtureId('sec')}`;
  settings.connectors.value.accounts = [
    {
      id: 'imap-work',
      name: 'Work mail',
      kind: 'email',
      provider: 'imap-smtp',
      secretRef: `secret://${fixtureId('sec')}`,
      scopes: ['email:read'],
      mode: 'read',
      options: { imapHost: 'imap.example.com', email: 'owner@example.com' },
    },
  ];
  const state = {
    settings,
    missions: options.empty ? ([] as Mission[]) : [fixtureMission(options.status)],
    approvals: [fixtureApproval(options.approval)],
    triggers: [] as Trigger[],
    control: controlSchema.parse({ paused: false, version: 5, updatedAt: stamp }),
    bindings: [] as Array<{
      id: string;
      senderId: string;
      chatId: string;
      projectId: string;
      createdAt: string;
    }>,
    missionInputs: [] as z.infer<typeof missionInputSchema>[],
    runInputs: [] as z.infer<typeof runControlSchema>[],
    decisions: [] as z.infer<typeof approvalDecisionSchema>[],
    decisionIds: [] as string[],
    conflictingDecisionId: null as string | null,
    triggerInputs: [] as z.infer<typeof triggerInputSchema>[],
    triggerUpdates: [] as z.infer<typeof triggerUpdateSchema>[],
    previews: [] as z.infer<typeof schedulePreviewInputSchema>[],
    policySaves: [] as unknown[],
    controls: [] as z.infer<typeof controlInputSchema>[],
    pairInputs: [] as z.infer<typeof telegramPairInputSchema>[],
    unpairs: [] as string[],
    manualRuns: 0,
  };
  const projects = [
    {
      id: projectId,
      name: 'Operations',
      brief: '',
      privacy: 'standard',
      budgetUsd: 5,
      createdAt: stamp,
    },
  ];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/auth/get-session')
      return route.fulfill({ json: { user: { id: 'browser-owner' } } });
    if (path === '/api/settings') return route.fulfill({ json: state.settings });
    if (
      [
        '/api/connectors/catalogue',
        '/api/mcp/servers',
        '/api/mcp/clients',
        '/api/bridge/devices',
      ].includes(path)
    )
      return route.fulfill({ json: [] });
    if (path === '/api/projects') return route.fulfill({ json: projects });
    if (path === `/api/projects/${projectId}/review` && request.method() === 'GET')
      return route.fulfill({
        json: projectReviewSchema.parse({ projectId, mode: 'off', version: 1 }),
      });
    if (/^\/api\/approvals\/[^/]+\/review$/.test(path) && request.method() === 'GET')
      return route.fulfill({ json: null });
    if (path === '/api/vault/secrets')
      return route.fulfill({
        json: [
          {
            id: fixtureId('sec'),
            reference: `secret://${fixtureId('sec')}`,
            name: 'Webhook signing',
            maskedValue: '••••',
            revision: 1,
          },
        ],
      });
    if (path === '/api/control') {
      if (request.method() === 'POST') {
        const input = controlInputSchema.parse(request.postDataJSON());
        state.controls.push(input);
        if (input.version !== state.control.version)
          return route.fulfill({
            status: 409,
            json: { error: { code: 'CONFLICT', message: 'Control changed.' } },
          });
        state.control = {
          ...state.control,
          paused: input.paused,
          version: state.control.version + 1,
        };
      }
      return route.fulfill({ json: state.control });
    }
    if (path === '/api/missions') {
      if (request.method() === 'POST') {
        const input = missionInputSchema.parse(request.postDataJSON());
        state.missionInputs.push(input);
        if (options.failFirstMission && state.missionInputs.length === 1)
          return route.fulfill({
            status: 503,
            json: {
              error: {
                code: 'UNAVAILABLE',
                message: 'The worker service is unavailable. Retry this request.',
              },
            },
          });
        const mission = {
          ...fixtureMission('queued'),
          title: input.title ?? input.goal,
          goal: input.goal,
          agent: input.agent,
        };
        state.missions = [mission];
        return route.fulfill({ json: mission });
      }
      return route.fulfill({ json: state.missions });
    }
    if (path === `/api/missions/${missionId}`)
      return route.fulfill({
        json: {
          mission: state.missions[0] ?? fixtureMission(),
          approvals: state.approvals,
          steps: [
            {
              id: fixtureId('step'),
              runId,
              ordinal: 0,
              agentId: 'cos',
              kind: 'plan',
              content: 'Research the current progress, then ask Comms to draft an update.',
              toolName: null,
              toolArgs: null,
              toolResult: null,
              providerId: 'fixture',
              modelId: 'fixture-model',
              inputTokens: 10,
              outputTokens: 10,
              costUsd: 0.1,
              createdAt: stamp,
            },
            {
              id: fixtureId('step', '2'),
              runId,
              ordinal: 1,
              agentId: 'researcher',
              kind: 'tool',
              content: 'Reviewed the project issue.',
              toolName: 'github.read_issue',
              toolArgs: { accountId: 'work-github', issueNumber: 42 },
              toolResult: '<untrusted>Release review is ready.</untrusted>',
              providerId: null,
              modelId: null,
              inputTokens: 0,
              outputTokens: 0,
              costUsd: 0,
              createdAt: stamp,
            },
          ],
          agentMessages: [
            {
              id: fixtureId('ams'),
              from: 'cos',
              to: 'comms',
              type: 'assign',
              content: 'Prepare the weekly update for review.',
              createdAt: stamp,
            },
          ],
        },
      });
    if (path === `/api/runs/${runId}/control`) {
      const input = runControlSchema.parse(request.postDataJSON());
      state.runInputs.push(input);
      const run = state.missions[0]!.run;
      if (input.version !== run.version)
        return route.fulfill({
          status: 409,
          json: { error: { code: 'CONFLICT', message: 'The run changed.' } },
        });
      run.status =
        input.action === 'pause' ? 'paused' : input.action === 'cancel' ? 'cancelled' : 'queued';
      run.version += 1;
      run.reason = null;
      run.limits.maxCostUsd += input.addCostUsd;
      run.limits.maxSteps += input.addSteps;
      run.limits.maxWallTimeSeconds += input.addWallTimeSeconds;
      return route.fulfill({ json: run });
    }
    if (path === '/api/approvals') return route.fulfill({ json: state.approvals });
    if (/^\/api\/approvals\/[^/]+\/decision$/.test(path)) {
      const input = approvalDecisionSchema.parse(request.postDataJSON());
      state.decisions.push(input);
      const id = path.split('/')[3]!;
      state.decisionIds.push(id);
      const index = state.approvals.findIndex((item) => item.id === id);
      if (index < 0)
        return route.fulfill({
          status: 404,
          json: { error: { code: 'NOT_FOUND', message: 'Approval unavailable.' } },
        });
      const approval = state.approvals[index]!;
      if (id === state.conflictingDecisionId) {
        state.approvals[index] = {
          ...approval,
          version: approval.version + 1,
          args: {
            accountId: 'work-mail',
            to: ['changed@example.com'],
            cc: [],
            subject: 'Changed after review',
            text: 'A different version needs review.',
          },
        };
        return route.fulfill({
          status: 409,
          json: { error: { code: 'CONFLICT', message: 'Request changed.' } },
        });
      }
      if (input.version !== approval.version)
        return route.fulfill({
          status: 409,
          json: { error: { code: 'CONFLICT', message: 'Request changed.' } },
        });
      state.approvals[index] = {
        ...approval,
        args: input.args ?? approval.args,
        status:
          input.action === 'deny'
            ? 'denied'
            : input.action.startsWith('confirm')
              ? 'resolved'
              : 'approved',
        version: approval.version + 1,
        note: input.note,
      };
      return route.fulfill({ json: state.approvals[index] });
    }
    if (path === '/api/settings/security' && request.method() === 'PUT') {
      const input = z
        .strictObject({ value: settingsSchemas.security, expectedVersion: z.number().int() })
        .parse(request.postDataJSON());
      state.policySaves.push(input);
      if (input.expectedVersion !== state.settings.security.version)
        return route.fulfill({
          status: 409,
          json: { error: { code: 'CONFLICT', message: 'Settings changed.' } },
        });
      state.settings.security = { value: input.value, version: input.expectedVersion + 1 };
      return route.fulfill({ json: { version: state.settings.security.version } });
    }
    if (path === '/api/triggers/preview') {
      const input = schedulePreviewInputSchema.parse(request.postDataJSON());
      state.previews.push(input);
      if (options.malformedPreview)
        return route.fulfill({ json: { summary: 'Unvalidated preview' } });
      return route.fulfill({
        json: {
          expression: input.expression ?? '0 9 * * 1-5',
          timezone: input.timezone,
          summary: 'Every weekday at 09:00',
          occurrences: ['2030-11-04T03:30:00.000Z', '2030-11-05T03:30:00.000Z'],
          reviewToken: 'reviewed-schedule-token',
          expiresAt: future,
        },
      });
    }
    if (path === '/api/triggers') {
      if (request.method() === 'POST') {
        const input = triggerInputSchema.parse(request.postDataJSON());
        state.triggerInputs.push(input);
        const trigger = triggerSchema.parse({
          id: fixtureId('trg', String(state.triggerInputs.length)),
          projectId: input.projectId,
          name: input.name,
          goal: input.goal,
          agent: input.agent,
          config: input.config,
          enabled: input.enabled,
          version: 1,
          nextRunAt: input.config.kind === 'cron' ? '2030-11-04T03:30:00.000Z' : null,
          lastRunAt: null,
          lastError: null,
          createdAt: stamp,
          webhookPath:
            input.config.kind === 'webhook'
              ? `/hooks/${fixtureId('trg', String(state.triggerInputs.length))}`
              : null,
        });
        state.triggers.push(trigger);
        return route.fulfill({ json: trigger });
      }
      return route.fulfill({ json: state.triggers });
    }
    if (path === `/api/triggers/${triggerId}` && request.method() === 'PUT') {
      const input = triggerUpdateSchema.parse(request.postDataJSON());
      state.triggerUpdates.push(input);
      const current = state.triggers[0]!;
      state.triggers[0] = { ...current, enabled: input.enabled, version: current.version + 1 };
      return route.fulfill({ json: state.triggers[0] });
    }
    if (path === `/api/triggers/${triggerId}/run`) {
      z.strictObject({}).parse(request.postDataJSON());
      state.manualRuns += 1;
      return route.fulfill({ json: fixtureMission('queued') });
    }
    if (path === '/api/channels/telegram')
      return route.fulfill({
        json: { configured: true, bindings: state.bindings, lastPollAt: stamp, lastError: null },
      });
    if (path === '/api/channels/telegram/pair') {
      const input = telegramPairInputSchema.parse(request.postDataJSON());
      state.pairInputs.push(input);
      return route.fulfill({
        json: { code: '482913', command: '/pair 482913', expiresAt: future },
      });
    }
    if (path.startsWith('/api/channels/telegram/bindings/') && request.method() === 'DELETE') {
      z.strictObject({}).parse(request.postDataJSON());
      const id = path.split('/').at(-1)!;
      state.unpairs.push(id);
      state.bindings = state.bindings.filter((binding) => binding.id !== id);
      return route.fulfill({ json: { ok: true } });
    }
    if (path === '/api/notifications')
      return route.fulfill({
        json: [
          {
            id: fixtureId('ntf'),
            projectId,
            missionId,
            level: 'normal',
            title: 'Quiet-hour update',
            body: 'The team finished the review.',
            status: 'deferred',
            dueAt: '2030-11-04T02:30:00.000Z',
            createdAt: stamp,
          },
          {
            id: fixtureId('ntf', '2'),
            projectId,
            missionId,
            level: 'urgent',
            title: 'Delivery needs verification',
            body: 'Please check the Telegram conversation.',
            status: 'uncertain',
            dueAt: null,
            createdAt: stamp,
          },
        ],
      });
    if (path === '/api/digests')
      return route.fulfill({
        json: [
          {
            id: fixtureId('dig'),
            title: 'Morning Brief',
            body: 'Your release is ready for review. Two priorities remain.',
            itemCount: 2,
            createdAt: stamp,
            deliveryStatus: 'web',
          },
        ],
      });
    return route.fulfill({
      status: 404,
      json: { error: { code: 'NOT_FOUND', message: 'No browser fixture for this request.' } },
    });
  });
  return state;
}
