import {
  expect,
  type BrowserContext,
  type Cookie,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { z } from 'zod';
import { freshSettings } from '@sazuz/config/settings';
import { chatInput, type WorkMessage } from '@sazuz/core/work';
import { speakInputSchema, transcribeInputSchema } from '@sazuz/core/voice';
import { voiceWav } from '../../packages/llm/src/speech';

// Synthetic owner sessions stay in this test worker's memory. Reusing a valid
// session keeps unrelated UI checks from exhausting the real login rate limit.
const ownerSessions = new Map<string, Cookie[]>();
export async function ownerApi(context: BrowserContext, info: TestInfo, configuredOrigin?: string) {
  const origin = z.string().parse(configuredOrigin ?? info.project.use.baseURL);
  const api = async <T>(method: string, path: string, schema: z.ZodType<T>, data?: unknown) => {
    const send = () =>
      context.request.fetch(`${origin}/api/${path}`, {
        method,
        headers: { origin },
        timeout: path === 'backups' && method === 'POST' ? 150000 : 10000,
        ...(data === undefined ? {} : { data }),
      });
    let response = await send();
    // A full multi-phase suite can arrive during an earlier fixture's login
    // window. Wait for the real limiter; never reset its database or relax it.
    for (
      let retry = 0;
      path === 'auth/sign-in/email' && response.status() === 429 && retry < 3;
      retry++
    ) {
      info.setTimeout(info.timeout + 22000);
      await new Promise((resolve) => setTimeout(resolve, 20000));
      response = await send();
    }
    expect(response.status(), `${method} ${path}`).toBe(200);
    return schema.parse(await response.json());
  };
  const saved = ownerSessions.get(origin);
  if (saved) await context.addCookies(saved);
  const session = await api(
    'GET',
    'auth/get-session',
    z.object({ user: z.object({ email: z.string() }) }).nullable(),
  );
  if (session?.user.email !== 'browser-owner@example.test') {
    await api('POST', 'auth/sign-in/email', z.unknown(), {
      email: 'browser-owner@example.test',
      password: 'Browser-admin-password-7814',
    });
    ownerSessions.set(origin, await context.cookies(origin));
  }
  return api;
}

export function silentWav() {
  const bytes = Buffer.alloc(32044);
  bytes.write('RIFF');
  bytes.writeUInt32LE(32036, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(32000, 40);
  return bytes;
}

/** Browser audio capture is real. Only the model/API responses are fixtures. */
export async function voiceWorkspace(page: Page) {
  const id = (prefix: string, digit = '1') => `${prefix}_${'0'.repeat(25)}${digit}`;
  const projectId = id('prj'),
    threadId = id('thr'),
    receiptId = id('spc');
  const stamp = '2026-11-05T12:00:00.000Z';
  const settings = freshSettings();
  settings.providers.version = 1;
  settings.speech.version = 1;
  settings.providers.value.items = [
    {
      id: 'voice-fixture',
      name: 'Local speech fixture',
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:7815/v1',
      secretRef: null,
      locality: 'local',
      enabled: true,
    },
  ];
  settings.models.value.roles.executor = { providerId: 'voice-fixture', modelId: 'fixture-model' };
  settings.speech.value = {
    enabled: true,
    maxRequestUsd: 0.05,
    transcription: { providerId: 'voice-fixture', modelId: 'tiny.en', pricePerMinuteUsd: 0 },
    synthesis: {
      providerId: 'voice-fixture',
      modelId: 'en_US-ljspeech-medium',
      voice: 'ljspeech',
      pricePerMillionCharactersUsd: 0,
    },
  };
  const chats: z.infer<typeof chatInput>[] = [],
    recordings: number[] = [],
    playback: string[] = [];
  let messages: WorkMessage[] = [];
  const receipt = {
    id: receiptId,
    kind: 'transcribe',
    status: 'done',
    projectId,
    providerId: 'voice-fixture',
    modelId: 'tiny.en',
    costUsd: 0,
    estimated: true,
    transcript: 'Please review my local voice note.',
    createdAt: stamp,
  };
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === '/api/auth/get-session')
      return route.fulfill({ json: { user: { id: 'browser-owner' } } });
    if (path === '/api/settings') return route.fulfill({ json: settings });
    if (path === '/api/projects')
      return route.fulfill({
        json: [
          {
            id: projectId,
            name: 'Local voice review',
            brief: '',
            privacy: 'private',
            budgetUsd: 5,
            createdAt: stamp,
          },
        ],
      });
    if (path === '/api/threads')
      return route.fulfill({
        json: [{ id: threadId, projectId, title: 'Reviewed voice notes', createdAt: stamp }],
      });
    if (path === `/api/threads/${threadId}/messages`) return route.fulfill({ json: messages });
    if (path === '/api/models')
      return route.fulfill({
        json: [
          {
            id: 'fixture-model',
            providerId: 'voice-fixture',
            name: 'Fixture model',
            contextWindow: 8192,
            maxOutput: 2048,
            supports: { tools: true, vision: false, json: true, caching: false, reasoning: false },
            price: { inputPerMTok: 0, outputPerMTok: 0 },
            locality: 'local',
          },
        ],
      });
    if (path === '/api/costs')
      return route.fulfill({ json: { totalUsd: 0, inputTokens: 0, outputTokens: 0 } });
    if (path === '/api/voice/transcribe') {
      const input = transcribeInputSchema.parse(request.postDataJSON());
      expect(input.projectId).toBe(projectId);
      expect(input.speechVersion).toBe(settings.speech.version);
      recordings.push(voiceWav(Buffer.from(input.audio, 'base64')).seconds);
      return route.fulfill({ json: { receipt, audio: null, mediaType: null } });
    }
    if (path === `/api/threads/${threadId}/chat`) {
      const input = chatInput.parse(request.postDataJSON());
      chats.push(input);
      const common = {
        threadId,
        createdAt: stamp,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        usageEstimated: true,
        toolCalls: [],
      };
      const answer: WorkMessage = {
        ...common,
        id: id('msg', '2'),
        role: 'assistant',
        trust: 'trusted',
        content: 'Your reviewed note is ready.',
        providerId: 'voice-fixture',
        modelId: 'fixture-model',
      };
      messages = [
        {
          ...common,
          id: id('msg'),
          role: 'user',
          trust: 'untrusted',
          content: input.content,
          providerId: null,
          modelId: null,
        },
        answer,
      ];
      return route.fulfill({
        contentType: 'text/event-stream',
        body: [
          { type: 'message.completed', message: answer },
          { type: 'run.status', status: 'completed' },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(''),
      });
    }
    if (path === '/api/voice/speak') {
      const input = speakInputSchema.parse(request.postDataJSON());
      playback.push(input.messageId);
      return route.fulfill({
        json: {
          receipt: { ...receipt, id: id('spc', '2'), kind: 'speak', transcript: null },
          audio: silentWav().toString('base64'),
          mediaType: 'audio/wav',
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND' } } });
  });
  return { chats, recordings, playback, receiptId };
}
