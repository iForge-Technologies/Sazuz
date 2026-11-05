import { describe, expect, it, vi } from 'vitest';
import {
  createTelegramClient,
  createTelegramHandler,
  createTelegramPairingCode,
  hashTelegramPairingCode,
  parseTelegramApprovalCallback,
  telegramApprovalButtons,
  type TelegramHandlerDependencies,
  type TelegramPairing,
} from './index.js';

const pairing: TelegramPairing = {
  userId: 'owner-one',
  projectId: 'project-one',
  senderId: '12345678',
  chatId: '12345678',
};
const signal = () => new AbortController().signal;
const incoming = (text: string, updateId = 1, sender = 12345678) => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    from: { id: sender, is_bot: false },
    chat: { id: sender, type: 'private' },
    text,
  },
});
const callback = (data: string, updateId = 5, callbackId = 'callback-one', sender = 12345678) => ({
  update_id: updateId,
  callback_query: {
    id: callbackId,
    from: { id: sender },
    message: { message_id: 4, chat: { id: sender, type: 'private' } },
    data,
  },
});

function dependencies(): TelegramHandlerDependencies {
  const updates = new Set<number>();
  const callbacks = new Set<string>();
  return {
    pair: vi.fn(() => Promise.resolve(null)),
    lookup: vi.fn(() => Promise.resolve(pairing)),
    consumeUpdate: vi.fn<TelegramHandlerDependencies['consumeUpdate']>((id) => {
      const fresh = !updates.has(id);
      updates.add(id);
      return Promise.resolve(fresh);
    }),
    consumeCallback: vi.fn<TelegramHandlerDependencies['consumeCallback']>((id) => {
      const fresh = !callbacks.has(id);
      callbacks.add(id);
      return Promise.resolve(fresh);
    }),
    audit: vi.fn(() => Promise.resolve()),
    mission: vi.fn(() => Promise.resolve('Task created.')),
    status: vi.fn(() => Promise.resolve('One task is running.')),
    stop: vi.fn(() => Promise.resolve('All agents paused.')),
    digest: vi.fn(() => Promise.resolve('Digest requested.')),
    decideApproval: vi.fn(() => Promise.resolve('accepted' as const)),
    reply: vi.fn(() => Promise.resolve()),
    answerCallback: vi.fn(() => Promise.resolve()),
  };
}

describe('Telegram private sender pairing and routing', () => {
  it('drops unpaired senders and records identifiers without message content', async () => {
    const deps = dependencies();
    deps.lookup = vi.fn(() => Promise.resolve(null));
    const result = await createTelegramHandler(deps).handle(
      incoming('Private content that must not enter audit.'),
    );
    expect(result.status).toBe('ignored');
    expect(deps.mission).not.toHaveBeenCalled();
    expect(deps.reply).not.toHaveBeenCalled();
    expect(deps.audit).toHaveBeenCalledWith({
      kind: 'unpaired_sender',
      updateId: 1,
      senderId: '12345678',
      chatId: '12345678',
    });
    expect(JSON.stringify(vi.mocked(deps.audit).mock.calls)).not.toContain('Private content');
  });

  it('rejects invalid boundaries, bots, groups, and pairing ownership mismatches', async () => {
    const deps = dependencies();
    const handler = createTelegramHandler(deps);
    expect((await handler.handle({ update_id: 'not-numeric' })).status).toBe('ignored');
    expect(
      (
        await handler.handle({
          update_id: 2,
          message: {
            message_id: 2,
            from: { id: 12345678, is_bot: true },
            chat: { id: 12345678, type: 'private' },
            text: 'Do this',
          },
        })
      ).status,
    ).toBe('ignored');
    expect(
      (
        await handler.handle({
          update_id: 3,
          message: {
            message_id: 3,
            from: { id: 12345678 },
            chat: { id: -123456, type: 'group' },
            text: '/stop',
          },
        })
      ).status,
    ).toBe('ignored');
    expect((await handler.handle(incoming('Task', 4, 99999999))).status).toBe('ignored');
    expect(deps.mission).not.toHaveBeenCalled();
    expect(deps.stop).not.toHaveBeenCalled();
  });

  it.each(['/pair', '/pair@sazuz_bot', '/start', '/start@sazuz_bot'])(
    'consumes only a code hash for %s and rejects code reuse',
    async (command) => {
      const now = new Date('2026-11-03T10:00:00Z');
      const code = createTelegramPairingCode(now);
      expect(code.code).toHaveLength(24);
      expect(code.codeHash).toBe(hashTelegramPairingCode(code.code));
      expect(code.expiresAt).toBe('2026-11-03T10:10:00.000Z');
      const deps = dependencies();
      deps.lookup = vi.fn(() => Promise.resolve(null));
      let consumed = false;
      deps.pair = vi.fn<TelegramHandlerDependencies['pair']>((input) => {
        const valid = !consumed && input.codeHash === code.codeHash;
        consumed = true;
        return Promise.resolve(valid ? pairing : null);
      });
      const handler = createTelegramHandler(deps);
      expect((await handler.handle(incoming(`${command} ${code.code}`))).status).toBe('paired');
      expect((await handler.handle(incoming(`${command} ${code.code}`, 2))).status).toBe('ignored');
      expect(deps.pair).toHaveBeenCalledWith({
        codeHash: code.codeHash,
        senderId: pairing.senderId,
        chatId: pairing.chatId,
      });
      expect(JSON.stringify(vi.mocked(deps.audit).mock.calls)).not.toContain(code.code);
      expect(deps.lookup).not.toHaveBeenCalled();
      expect(deps.mission).not.toHaveBeenCalled();
      expect(() => createTelegramPairingCode(now, 3600000)).toThrow();
    },
  );

  it('binds missions to the paired project, supplies a durable update key, and deduplicates repeated deliveries', async () => {
    const deps = dependencies();
    const handler = createTelegramHandler(deps);
    const update = incoming('Prepare the project briefing');
    expect((await handler.handle(update)).status).toBe('mission');
    expect((await handler.handle(update)).status).toBe('duplicate');
    expect(deps.mission).toHaveBeenCalledExactlyOnceWith({
      pairing,
      text: 'Prepare the project briefing',
      idempotencyKey: 'telegram:1',
    });
    expect(deps.reply).toHaveBeenCalledWith(pairing, 'Task created.');
  });

  it('routes status, kill switch, and digest commands only after a valid pairing lookup', async () => {
    const deps = dependencies();
    const handler = createTelegramHandler(deps);
    for (const [index, command] of ['/status', '/stop@sazuz_bot', '/digest'].entries())
      expect((await handler.handle(incoming(command, index + 1))).status).toBe('command');
    expect(deps.status).toHaveBeenCalledExactlyOnceWith(pairing);
    expect(deps.stop).toHaveBeenCalledExactlyOnceWith(pairing);
    expect(deps.digest).toHaveBeenCalledExactlyOnceWith(pairing);
    expect(deps.mission).not.toHaveBeenCalled();
  });
});

describe('Telegram approval binding', () => {
  it('uses compact versioned callbacks and calls the ownership/expiry transaction once', async () => {
    const buttons = telegramApprovalButtons({
      approvalId: '01JAABCDEFGHIJKLMN01234567',
      version: 36,
      viewUrl: 'http://localhost:3000/missions',
    });
    const approve = buttons.inline_keyboard[0]![0]!;
    if (!('callback_data' in approve)) throw new Error('Fixture button missing callback.');
    expect(Buffer.byteLength(approve.callback_data)).toBeLessThanOrEqual(64);
    expect(parseTelegramApprovalCallback(approve.callback_data)).toEqual({
      approvalId: '01JAABCDEFGHIJKLMN01234567',
      version: 36,
      decision: 'approve',
    });
    const deps = dependencies();
    const handler = createTelegramHandler(deps);
    expect((await handler.handle(callback(approve.callback_data))).status).toBe('approval');
    expect((await handler.handle(callback(approve.callback_data, 6))).status).toBe('duplicate');
    expect(deps.decideApproval).toHaveBeenCalledExactlyOnceWith({
      pairing,
      approvalId: '01JAABCDEFGHIJKLMN01234567',
      version: 36,
      decision: 'approve',
      callbackId: 'callback-one',
    });
    expect(deps.answerCallback).toHaveBeenCalledWith('callback-one', 'Approved.');
  });

  it('rejects forged versions, stale decisions, other senders, and unsafe View URLs', async () => {
    expect(parseTelegramApprovalCallback('a:approval:0:y')).toBeNull();
    expect(parseTelegramApprovalCallback('a:approval:01:y')).toBeNull();
    expect(parseTelegramApprovalCallback('a:approval:zzzzzzzzzz:y')).toBeNull();
    expect(() =>
      telegramApprovalButtons({
        approvalId: 'approval',
        version: 1,
        viewUrl: 'javascript:alert(1)',
      }),
    ).toThrow();
    const deps = dependencies();
    deps.decideApproval = vi.fn(() => Promise.resolve('stale' as const));
    const handler = createTelegramHandler(deps);
    expect((await handler.handle(callback('a:approval:2:y'))).status).toBe('ignored');
    expect(deps.answerCallback).toHaveBeenCalledWith(
      'callback-one',
      'This approval is no longer available.',
    );
    expect(
      (await handler.handle(callback('a:approval:2:y', 6, 'another-callback', 99999999))).status,
    ).toBe('ignored');
    expect(deps.decideApproval).toHaveBeenCalledTimes(1);
  });
});

describe('official Telegram Bot API client', () => {
  const token = '123456789:telegram-client-fixture-credential-4329834933';
  function client(fetcher: typeof fetch, value = token) {
    return createTelegramClient({
      secretRef: 'secret://telegram-bot',
      secret: <T>(_ref: string, consume: (value: string) => Promise<T>) => consume(value),
      fetch: fetcher,
    });
  }

  it('long-polls only supported update types and sends to an explicitly authorized private recipient', async () => {
    const methods: string[] = [];
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      expect(url.origin).toBe('https://api.telegram.org');
      expect(init?.redirect).toBe('error');
      const method = url.pathname.split('/').at(-1)!;
      methods.push(method);
      if (typeof init?.body !== 'string')
        throw new Error('The fixture requires a JSON request body.');
      const body = JSON.parse(init.body) as unknown;
      if (method === 'getMe') {
        expect(body).toEqual({});
        return Promise.resolve(
          Response.json({
            ok: true,
            result: { id: 123456789, is_bot: true, username: 'sazuz_fixture_bot' },
          }),
        );
      }
      if (method === 'getUpdates') {
        expect(body).toEqual({
          offset: 9,
          timeout: 20,
          limit: 100,
          allowed_updates: ['message', 'callback_query'],
        });
        return Promise.resolve(Response.json({ ok: true, result: [incoming('Task', 9)] }));
      }
      if (method === 'answerCallbackQuery') {
        expect(body).toEqual({ callback_query_id: 'callback-one', text: 'Approved.' });
        return Promise.resolve(Response.json({ ok: true, result: true }));
      }
      expect(body).toMatchObject({
        chat_id: pairing.chatId,
        text: 'Approval required',
        reply_markup: telegramApprovalButtons({ approvalId: 'approval', version: 1 }),
      });
      return Promise.resolve(
        Response.json({ ok: true, result: { message_id: 32, chat: { id: 12345678 } } }),
      );
    });
    const api = client(fetcher);
    expect(await api.getIdentity()).toBe('123456789');
    expect(await api.getUpdates({ offset: 9, signal: signal() })).toHaveLength(1);
    expect(
      await api.sendMessage(
        {
          recipient: pairing,
          text: 'Approval required',
          replyMarkup: telegramApprovalButtons({ approvalId: 'approval', version: 1 }),
        },
        signal(),
      ),
    ).toEqual({ messageId: 32, chatId: pairing.chatId });
    await api.answerCallbackQuery({ callbackId: 'callback-one', text: 'Approved.' }, signal());
    expect(methods).toEqual(['getMe', 'getUpdates', 'sendMessage', 'answerCallbackQuery']);
    expect(api.verifyDelivery()).toEqual({ status: 'unknown' });
  });

  it.each([
    { id: 123456789, is_bot: false },
    { id: '123456789', is_bot: true },
    { id: Number.MAX_SAFE_INTEGER + 1, is_bot: true },
    { id: -123456789, is_bot: true },
    { is_bot: true },
  ])('rejects an invalid identity before callers persist a bot namespace', async (result) => {
    const api = client(vi.fn(() => Promise.resolve(Response.json({ ok: true, result }))));
    await expect(api.getIdentity(signal())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('cancels identity lookup before resolving credentials or contacting Telegram', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    const secretCalled = vi.fn<() => void>();
    const api = createTelegramClient({
      secretRef: 'secret://telegram-bot',
      secret: <T>(_reference: string, consume: (value: string) => Promise<T>) => {
        secretCalled();
        return consume(token);
      },
      fetch: fetcher,
    });
    await expect(api.getIdentity(controller.signal)).rejects.toMatchObject({
      code: 'CANCELLED',
      delivery: 'not_sent',
    });
    expect(secretCalled).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps transport failures ambiguous, handles explicit rejections, and never leaks a bot token in errors', async () => {
    const broken = client(
      vi.fn(() => Promise.reject(new Error(`https://api.telegram.org/bot${token}/sendMessage`))),
    );
    const result = broken.sendMessage({ recipient: pairing, text: 'Hello' }, signal());
    await expect(result).rejects.toMatchObject({
      code: 'TRANSPORT_FAILED',
      delivery: 'unknown',
      message: 'The Telegram operation could not be completed.',
    });
    const rejected = client(
      vi.fn(() =>
        Promise.resolve(
          Response.json({ ok: false, error_code: 403, description: token }, { status: 403 }),
        ),
      ),
    );
    await expect(
      rejected.sendMessage({ recipient: pairing, text: 'Hello' }, signal()),
    ).rejects.toMatchObject({ code: 'REQUEST_REJECTED', delivery: 'not_sent' });
  });

  it('blocks resolved credentials in outbound text and rejects mismatched recipient IDs before transport', async () => {
    const newToken = '987654321:new-telegram-only-at-execution-value-7392379';
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      client(fetcher, newToken).sendMessage(
        { recipient: pairing, text: `Please include ${newToken}` },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', delivery: 'not_sent' });
    await expect(
      client(fetcher).sendMessage(
        { recipient: { ...pairing, chatId: '99999999' }, text: 'Hello' },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', delivery: 'not_sent' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('bounds response size and responds to cancellation while the transport is stalled', async () => {
    const oversized = client(
      vi.fn(() => Promise.resolve(new Response('x', { headers: { 'content-length': '1048577' } }))),
    );
    await expect(oversized.getUpdates({ signal: signal() })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
    const stalled = client(vi.fn(() => new Promise<Response>(() => undefined)));
    const controller = new AbortController();
    const operation = stalled.sendMessage({ recipient: pairing, text: 'Hello' }, controller.signal);
    controller.abort();
    await expect(operation).rejects.toMatchObject({ code: 'CANCELLED', delivery: 'unknown' });
    const fetcher = vi.fn<typeof fetch>();
    await expect(client(fetcher).getUpdates({ signal: controller.signal })).rejects.toMatchObject({
      delivery: 'not_sent',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('times out a stalled Bot API request without retrying an uncertain send', async () => {
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
    const api = createTelegramClient({
      secretRef: 'secret://telegram-bot',
      secret: <T>(_reference: string, consume: (value: string) => Promise<T>) => consume(token),
      fetch: fetcher,
      timeoutMs: 20,
    });
    await expect(
      api.sendMessage({ recipient: pairing, text: 'Approval required' }, signal()),
    ).rejects.toMatchObject({ code: 'CANCELLED', delivery: 'unknown' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(api.verifyDelivery()).toEqual({ status: 'unknown' });
  });
});
