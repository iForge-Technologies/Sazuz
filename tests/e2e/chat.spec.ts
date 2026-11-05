import { expect, test, type Page } from '@playwright/test';
import { freshSettings } from '@sazuz/config/settings';
import {
  chatInput,
  projectInput,
  threadInput,
  type ChatEvent,
  type WorkMessage,
} from '@sazuz/core/work';

declare global {
  interface Window {
    __sazuzCompleteChat?: () => void;
  }
}

const projectId = `prj_${'0'.repeat(25)}1`;
const threadId = `thr_${'0'.repeat(25)}1`;
const stamp = '2026-11-03T12:00:00.000Z';
const fixtureModel = {
  id: 'fixture-model',
  providerId: 'fixture',
  name: 'Fixture model',
  contextWindow: 8192,
  maxOutput: 2048,
  supports: { tools: true, vision: false, json: true, caching: false, reasoning: false },
  price: { inputPerMTok: 1, outputPerMTok: 2 },
  locality: 'local',
};
const fixtureProvider = {
  id: 'fixture',
  name: 'Fixture Ollama',
  kind: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  secretRef: null,
  locality: 'local',
  enabled: true,
};

function assistantMessage(): WorkMessage {
  return {
    id: `msg_${'0'.repeat(25)}2`,
    threadId,
    role: 'assistant',
    content: 'The current time is 12:00 UTC.',
    trust: 'trusted',
    createdAt: stamp,
    providerId: 'fixture',
    modelId: 'fixture-model',
    inputTokens: 120,
    outputTokens: 15,
    costUsd: 0.00015,
    usageEstimated: false,
    toolCalls: [{ id: 'clock-call', name: 'time.now', args: {} }],
  };
}

function sse(events: ChatEvent[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

async function mockWorkspace(
  page: Page,
  options: { empty?: boolean; malformed?: boolean; noModels?: boolean; events?: ChatEvent[] } = {},
) {
  const projects: Array<ReturnType<typeof projectInput.parse> & { id: string; createdAt: string }> =
    options.empty
      ? []
      : [
          {
            id: projectId,
            name: 'Private research',
            brief: '',
            privacy: 'private',
            budgetUsd: 5,
            createdAt: stamp,
          },
        ];
  const threads = options.empty
    ? []
    : [{ id: threadId, projectId, title: 'Morning notes', createdAt: stamp }];
  let messages: WorkMessage[] = [];
  const catalog = options.noModels ? [] : [structuredClone(fixtureModel)];
  const settings = freshSettings();
  settings.providers.value.items = [{ ...fixtureProvider, kind: 'ollama', locality: 'local' }];
  settings.models.value.roles.executor = options.noModels
    ? null
    : { providerId: 'fixture', modelId: 'fixture-model' };
  const sent: ReturnType<typeof chatInput.parse>[] = [];
  const prices: unknown[] = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/auth/get-session')
      return route.fulfill({ json: { user: { id: 'browser-owner' } } });
    if (path === '/api/settings') return route.fulfill({ json: settings });
    if (path === '/api/providers') return route.fulfill({ json: [fixtureProvider] });
    if (path === '/api/models') return route.fulfill({ json: catalog });
    if (path === '/api/costs')
      return route.fulfill({
        json: {
          totalUsd: messages.length ? 0.00015 : 0,
          inputTokens: messages.length ? 120 : 0,
          outputTokens: messages.length ? 15 : 0,
        },
      });
    if (path === '/api/projects') {
      if (request.method() === 'POST') {
        const input = projectInput.parse(request.postDataJSON());
        const project = { ...input, privacy: input.privacy, id: projectId, createdAt: stamp };
        // This fixture creates one project; the real API owns IDs and authorization.
        projects.splice(0, projects.length, project);
        return route.fulfill({ json: project });
      }
      return route.fulfill({ json: projects });
    }
    if (path === '/api/threads') {
      if (request.method() === 'POST') {
        const input = threadInput.parse(request.postDataJSON());
        const thread = { ...input, id: threadId, createdAt: stamp };
        threads.push(thread);
        return route.fulfill({ json: thread });
      }
      const selected = new URL(request.url()).searchParams.get('projectId');
      return route.fulfill({ json: threads.filter((thread) => thread.projectId === selected) });
    }
    if (path === `/api/threads/${threadId}/messages`) return route.fulfill({ json: messages });
    if (path === `/api/threads/${threadId}/chat`) {
      const input = chatInput.parse(request.postDataJSON());
      sent.push(input);
      const answer = assistantMessage();
      messages = [
        {
          ...answer,
          id: `msg_${'0'.repeat(25)}1`,
          role: 'user',
          content: input.content,
          providerId: null,
          modelId: null,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          toolCalls: [],
        },
        ...(options.events ? [] : [answer]),
      ];
      return route.fulfill({
        contentType: 'text/event-stream',
        body: options.malformed
          ? 'data: {"type":"text.delta","text":{"private":"secret-canary"}}\n\n'
          : sse(
              options.events ?? [
                { type: 'text.delta', text: 'Checking the time…' },
                { type: 'tool.call', id: 'clock-call', name: 'time.now', args: {} },
                {
                  type: 'tool.result',
                  id: 'clock-call',
                  name: 'time.now',
                  output: { utc: '12:00' },
                  status: 'done',
                },
                { type: 'message.completed', message: answer },
                { type: 'run.status', status: 'completed' },
              ],
            ),
      });
    }
    if (path === '/api/providers/fixture/discover') {
      catalog.splice(0, catalog.length, structuredClone(fixtureModel));
      return route.fulfill({ json: { models: catalog } });
    }
    if (path === '/api/providers/fixture/test')
      return route.fulfill({
        json: { providerId: 'fixture', ok: true, latencyMs: 28, modelCount: 1, code: 'READY' },
      });
    if (path === '/api/models/prices') {
      const input: unknown = request.postDataJSON();
      prices.push(input);
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND' } } });
  });
  return { sent, prices };
}

test('chat keyboard send submits once and preserves ordinary Enter for a new line', async ({
  page,
}) => {
  const state = await mockWorkspace(page);
  await page.goto('/chat');
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(message).toBeEnabled();
  await message.fill('First line');
  await message.press('Enter');
  await message.press('x');
  await expect(message).toHaveValue('First line\nx');
  expect(state.sent).toHaveLength(0);
  await message.press('Control+Enter');
  await expect(page.getByRole('status')).toContainText('Response complete.');
  await expect(message).toBeEnabled();
  expect(state.sent).toHaveLength(1);
  expect(state.sent[0]?.content).toBe('First line\nx');
  await message.press('Control+Enter');
  expect(state.sent).toHaveLength(1);
  await message.fill('Second request');
  await message.press('Meta+Enter');
  await expect(message).toHaveValue('');
  await expect(page.getByRole('status')).toContainText('Response complete.');
  await expect(message).toBeEnabled();
  expect(state.sent).toHaveLength(2);
  expect(state.sent[1]?.content).toBe('Second request');
  expect(state.sent[1]?.requestId).not.toBe(state.sent[0]?.requestId);
});

test('chat preserves a scrolled reading position and Jump to latest restores following', async ({
  page,
}) => {
  await mockWorkspace(page);
  const historicalMessage = (index: number): WorkMessage => ({
    ...assistantMessage(),
    id: `msg_${String(index + 10).padStart(26, '0')}`,
    content: `Research note ${index + 1}. ${'A deliberately long saved passage provides a useful place to resume reading. '.repeat(8)}`,
    toolCalls: [],
  });
  const history = Array.from({ length: 32 }, (_, index) => historicalMessage(index));
  await page.route(`**/api/threads/${threadId}/messages`, (route) =>
    route.fulfill({ json: history }),
  );
  await page.goto('/chat');
  const messages = page.getByRole('article', { name: 'assistant message', exact: true });
  const transcript = page.locator('.chat-messages');
  const distanceFromBottom = () =>
    transcript.evaluate(
      (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
    );
  await expect(messages).toHaveCount(32);
  await expect.poll(distanceFromBottom).toBeLessThan(60);
  expect(
    await transcript.evaluate((element) => element.scrollHeight - element.clientHeight),
  ).toBeGreaterThan(1000);
  await transcript.hover();
  await page.mouse.wheel(0, -100000);
  const jump = page.getByRole('button', { name: 'Jump to latest', exact: true });
  await expect(jump).toBeVisible();
  await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBeLessThan(50);
  history.push(historicalMessage(32));
  await page.getByRole('button', { name: 'Refresh conversation', exact: true }).click();
  await expect(messages).toHaveCount(33);
  expect(await transcript.evaluate((element) => element.scrollTop)).toBeLessThan(50);
  await expect(jump).toBeVisible();
  await jump.click();
  await expect(jump).not.toBeVisible();
  await expect.poll(distanceFromBottom).toBeLessThan(60);
  history.push(historicalMessage(33));
  await page.getByRole('button', { name: 'Refresh conversation', exact: true }).click();
  await expect(messages).toHaveCount(34);
  await expect.poll(distanceFromBottom).toBeLessThan(60);
});

test.describe('mocked chat and model UI regressions', () => {
  test('creates a private project and conversation, renders tools, and preserves per-message usage', async ({
    page,
  }, testInfo) => {
    const state = await mockWorkspace(page, { empty: true });
    const browserErrors: string[] = [];
    page.on('pageerror', () => browserErrors.push('Browser runtime error'));
    await page.goto('/chat');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toBeFocused();
    await page.getByLabel('Project name', { exact: true }).fill('Private research');
    await page.getByRole('combobox', { name: 'Privacy', exact: true }).selectOption('private');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await page.getByLabel('Conversation title', { exact: true }).fill('Morning notes');
    await page.getByRole('button', { name: 'Create conversation', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Morning notes', exact: true })).toBeVisible();
    await expect(page.getByText('Private · local models only', { exact: true })).toBeVisible();
    await page.getByLabel('Message', { exact: true }).fill('What time is it?');
    await page.getByRole('button', { name: 'Send message' }).click();
    const answer = page.getByRole('article', { name: 'assistant message', exact: true });
    await expect(answer).toContainText('The current time is 12:00 UTC.');
    await expect(answer).toContainText('fixture / fixture-model');
    await expect(answer).toContainText('120 input · 15 output tokens');
    await expect(answer).toContainText('$0.000150');
    const activity = page.getByRole('region', { name: 'Tool activity' });
    await activity.getByText('time.now', { exact: true }).click();
    await expect(activity).toContainText('12:00');
    await expect(page.getByRole('status')).toContainText('Response complete.');
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]?.requestId).toMatch(/^[a-f0-9-]{36}$/);
    await page.screenshot({ path: testInfo.outputPath('chat-desktop.png'), fullPage: true });
    await page.getByRole('button', { name: 'Refresh conversation' }).click();
    await expect(page.getByRole('article', { name: 'user message', exact: true })).toHaveCount(1);
    await expect(answer).toHaveCount(1);
    await page.setViewportSize({ width: 320, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      320,
    );
    await page.screenshot({ path: testInfo.outputPath('chat-mobile.png'), fullPage: true });
    expect(browserErrors).toEqual([]);
  });

  test('malformed stream never renders its payload and offers a safe refresh', async ({ page }) => {
    await mockWorkspace(page, { malformed: true });
    await page.goto('/chat');
    await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
    await page.getByLabel('Message', { exact: true }).fill('Check the time');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText('invalid chat event');
    await expect(page.getByRole('main')).not.toContainText('secret-canary');
    await expect(page.getByRole('button', { name: 'Refresh conversation' })).toBeEnabled();
    await page.getByRole('button', { name: 'Refresh conversation' }).click();
    await expect(
      page.getByRole('article', { name: 'assistant message', exact: true }),
    ).toContainText('12:00 UTC');
    await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
  });

  for (const status of ['waiting_approval', 'cancelled', 'stream_interrupted']) {
    test(`links the saved mission after ${status} ends chat observation`, async ({ page }) => {
      const missionPath = `/missions/mis_${'0'.repeat(25)}1`;
      const explanation =
        status === 'stream_interrupted'
          ? 'Live updates ended. Your saved mission can continue.'
          : status === 'cancelled'
            ? 'The mission was cancelled.'
            : 'Review the proposed action in the mission.';
      const state = await mockWorkspace(page, {
        events: [
          {
            type: 'run.status',
            status,
            message: `${explanation} View mission: ${missionPath}`,
          },
        ],
      });
      await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url().endsWith(`/api/threads/${threadId}/messages`) &&
            response.status() === 200,
        ),
        page.goto('/chat'),
      ]);
      await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
      await page.getByLabel('Message', { exact: true }).fill('Prepare my update');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(page.getByRole('status')).toContainText(explanation);
      await expect(page.getByRole('link', { name: 'View mission', exact: true })).toHaveAttribute(
        'href',
        missionPath,
      );
      await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
      await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
      expect(state.sent).toHaveLength(1);
    });
  }

  test('a disconnected observation keeps the saved mission link and does not imply cancellation', async ({
    page,
  }) => {
    const missionPath = `/missions/mis_${'0'.repeat(25)}1`;
    const state = await mockWorkspace(page, {
      events: [
        {
          type: 'run.status',
          status: 'running',
          message: `The mission is running. View mission: ${missionPath}`,
        },
      ],
    });
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/threads/${threadId}/messages`) && response.status() === 200,
      ),
      page.goto('/chat'),
    ]);
    await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
    await page.getByLabel('Message', { exact: true }).fill('Prepare my update');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const alert = page.getByRole('main').getByRole('alert');
    await expect(alert).toContainText('A saved mission can continue');
    await expect(alert.getByRole('link', { name: 'View saved mission' })).toHaveAttribute(
      'href',
      missionPath,
    );
    await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
    expect(state.sent).toHaveLength(1);
  });

  test('shows partial text before completion and prevents switching context during a response', async ({
    page,
  }) => {
    await mockWorkspace(page);
    await page.addInitScript(() => {
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const response = await nativeFetch(input, init);
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.endsWith('/chat') || init?.method !== 'POST') return response;
        const body = await response.text();
        const boundary = body.indexOf('\n\n') + 2;
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(body.slice(0, boundary)));
              window.__sazuzCompleteChat = () => {
                controller.enqueue(encoder.encode(body.slice(boundary)));
                controller.close();
              };
            },
          }),
          { status: response.status, headers: response.headers },
        );
      };
    });
    await page.goto('/chat');
    await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
    await page.getByLabel('Message', { exact: true }).fill('Check the clock');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(
      page.getByRole('article', { name: 'Streaming response', exact: true }),
    ).toContainText('Checking the time…');
    await expect(page.getByRole('button', { name: 'Working…', exact: true })).toBeDisabled();
    await expect(
      page.getByRole('combobox', { name: 'Current project', exact: true }),
    ).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Morning notes', exact: true })).toBeDisabled();
    await page.evaluate(() => window.__sazuzCompleteChat?.());
    await expect(
      page.getByRole('article', { name: 'assistant message', exact: true }),
    ).toContainText('The current time is 12:00 UTC.');
    await expect(
      page.getByRole('article', { name: 'Streaming response', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('combobox', { name: 'Current project', exact: true }),
    ).toBeEnabled();
  });

  test('provider discovery, connection tests and edited token prices work without credential inputs', async ({
    page,
  }, testInfo) => {
    const state = await mockWorkspace(page, { noModels: true });
    await page.goto('/models');
    await expect(page.getByText('Assign an executor model in', { exact: false })).toBeVisible();
    const provider = page.getByRole('region', { name: 'Fixture Ollama', exact: true });
    await provider.getByRole('button', { name: 'Discover models' }).click();
    const model = provider.getByRole('article', { name: 'Fixture model', exact: true });
    await expect(model).toContainText('8,192 context tokens');
    await provider.getByLabel('Model to test').selectOption('fixture-model');
    await provider.getByRole('button', { name: 'Test connection' }).click();
    await expect(provider.getByRole('status')).toContainText(
      'Connected · 28 ms · 1 models available',
    );
    await model.getByText('Edit prices', { exact: true }).click();
    await model.getByLabel('Input price', { exact: true }).fill('0.5');
    await model.getByLabel('Output price', { exact: true }).fill('1.25');
    await model.getByLabel('Cached input price (optional)', { exact: true }).fill('0.1');
    await model.getByRole('button', { name: 'Save prices' }).click();
    await expect(model.getByRole('status')).toContainText('Prices saved.');
    expect(state.prices).toEqual([
      {
        providerId: 'fixture',
        modelId: 'fixture-model',
        price: { inputPerMTok: 0.5, outputPerMTok: 1.25, cachedInputPerMTok: 0.1 },
      },
    ]);
    await expect(model).toContainText('$0.5 input / $1.25 output');
    await page.setViewportSize({ width: 320, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      320,
    );
    await page.screenshot({ path: testInfo.outputPath('models-mobile.png'), fullPage: true });
  });

  test('unauthenticated chat redirects to sign in before loading private projects', async ({
    page,
  }) => {
    let projectRequests = 0;
    await page.route('**/api/auth/get-session', (route) => route.fulfill({ json: null }));
    await page.route('**/api/projects', (route) => {
      projectRequests++;
      return route.fulfill({ json: [] });
    });
    await page.goto('/chat');
    await expect(page).toHaveURL(/\/login$/);
    expect(projectRequests).toBe(0);
  });
});
