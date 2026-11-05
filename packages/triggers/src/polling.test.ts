import { describe, expect, it, vi } from 'vitest';
import type { ImapTriggerConfig } from './contracts.js';
import {
  initialImapCursor,
  pollBackoff,
  pollImapTrigger,
  type ImapPollMessage,
} from './polling.js';

const now = new Date('2026-11-03T09:00:00.000Z');
const config: ImapTriggerConfig = {
  kind: 'imap',
  connectorId: 'personal_mail',
  mailbox: 'INBOX',
  pollIntervalSeconds: 300,
};
const input = {
  triggerId: 'trg_mail',
  config,
  now,
  cursor: { uidValidity: '17', lastUid: 41 },
  signal: new AbortController().signal,
};
function message(uid: number): ImapPollMessage {
  return {
    uid,
    messageId: `mail-${uid}`,
    subject: `Subject ${uid}`,
    from: 'sender@example.com',
    text: 'Mail body',
    receivedAt: now.toISOString(),
  };
}

describe('incremental IMAP polling', () => {
  it('returns a deterministic event and cursor proposal, suppressing repeated UIDs', async () => {
    const listMessages = vi.fn(() =>
      Promise.resolve({
        uidValidity: '17',
        messages: [message(43), message(41), message(42), message(42)],
        hasMore: false,
      }),
    );
    const result = await pollImapTrigger(input, { listMessages });
    expect(listMessages).toHaveBeenCalledWith({
      connectorId: 'personal_mail',
      mailbox: 'INBOX',
      afterUid: 41,
      uidValidity: '17',
      limit: 100,
      signal: input.signal,
    });
    expect(result.candidates.map((item) => item.payload.uid)).toEqual([42, 43]);
    expect(result.candidates.every((item) => item.untrusted)).toBe(true);
    expect(result.nextCursor).toEqual({ uidValidity: '17', lastUid: 43 });
    expect(input.cursor.lastUid).toBe(41);
    expect(result.nextPollAt).toBe('2026-11-03T09:05:00.000Z');
    expect(await pollImapTrigger(input, { listMessages })).toEqual(result);
    expect(
      (await pollImapTrigger({ ...input, cursor: result.nextCursor }, { listMessages })).candidates,
    ).toEqual([]);
  });

  it('starts a new UID namespace on UIDVALIDITY reset and includes the mailbox in identity', async () => {
    const listMessages = () =>
      Promise.resolve({ uidValidity: '18', messages: [message(1), message(2)], hasMore: false });
    const result = await pollImapTrigger(input, { listMessages });
    expect(result.nextCursor).toEqual({ uidValidity: '18', lastUid: 2 });
    expect(result.candidates).toHaveLength(2);
    const originalNamespace = await pollImapTrigger(
      { ...input, cursor: initialImapCursor },
      {
        listMessages: () =>
          Promise.resolve({ uidValidity: '17', messages: [message(1)], hasMore: false }),
      },
    );
    expect(result.candidates[0]!.dedupeKey).not.toBe(originalNamespace.candidates[0]!.dedupeKey);
    const anotherMailbox = await pollImapTrigger(
      { ...input, config: { ...config, mailbox: 'Archive' } },
      { listMessages },
    );
    expect(result.candidates[0]!.dedupeKey).not.toBe(anotherMailbox.candidates[0]!.dedupeKey);
  });

  it('advances empty sparse UID windows without downloading the whole mailbox', async () => {
    const result = await pollImapTrigger(input, {
      listMessages: () =>
        Promise.resolve({ uidValidity: '17', messages: [], scannedThrough: 1000, hasMore: true }),
    });
    expect(result.nextCursor).toEqual({ uidValidity: '17', lastUid: 1000 });
    expect(result.candidates).toEqual([]);
    expect(result.nextPollAt).toBe('2026-11-03T09:00:01.000Z');
  });

  it('accepts the connector transport limits without dropping a valid message or cursor', async () => {
    const incoming = {
      ...message(42),
      from: 'a'.repeat(4000),
      text: 'b'.repeat(131_072),
      messageId: 'c'.repeat(1000),
    };
    const result = await pollImapTrigger(input, {
      listMessages: () =>
        Promise.resolve({ uidValidity: '17', messages: [incoming], hasMore: false }),
    });
    expect(result.candidates[0]?.payload).toMatchObject(incoming);
    expect(result.nextCursor).toEqual({ uidValidity: '17', lastUid: 42 });
  });

  it.each([
    { uidValidity: '17', messages: [message(42)], scannedThrough: 40, hasMore: true },
    { uidValidity: '17', messages: [], hasMore: true },
    { uidValidity: '0', messages: [], hasMore: false },
    { uidValidity: '17', messages: [{ ...message(42), uid: -1 }], hasMore: false },
    { uidValidity: '17', messages: [message(42)], hasMore: false, extra: 'invalid' },
  ])(
    'rejects malformed or non-progressing connector results before cursor commit',
    async (result) => {
      await expect(
        pollImapTrigger(input, { listMessages: () => Promise.resolve(result) }),
      ).rejects.toMatchObject({ code: 'INVALID_POLL_RESULT' });
      expect(input.cursor.lastUid).toBe(41);
    },
  );

  it('honors a bounded page size and cancellation, and suppresses raw connector errors', async () => {
    await expect(
      pollImapTrigger(
        { ...input, limit: 1 },
        {
          listMessages: () =>
            Promise.resolve({
              uidValidity: '17',
              messages: [message(42), message(43)],
              hasMore: true,
            }),
        },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_POLL_RESULT' });
    await expect(
      pollImapTrigger(input, {
        listMessages: () => Promise.reject(new Error('password=fixture-secret')),
      }),
    ).rejects.toThrow('The polling source could not be read.');
    const controller = new AbortController();
    controller.abort();
    const listMessages = vi.fn(() => Promise.resolve({}));
    await expect(
      pollImapTrigger({ ...input, signal: controller.signal }, { listMessages }),
    ).rejects.toMatchObject({ code: 'POLL_ABORTED' });
    expect(listMessages).not.toHaveBeenCalled();
  });

  it('computes bounded backoff from durable failure counts and resets after success', () => {
    expect(
      pollBackoff({ baseIntervalSeconds: 300, consecutiveFailures: 0, now }).delaySeconds,
    ).toBe(300);
    expect(pollBackoff({ baseIntervalSeconds: 300, consecutiveFailures: 2, now })).toEqual({
      delaySeconds: 1200,
      nextPollAt: '2026-11-03T09:20:00.000Z',
    });
    expect(
      pollBackoff({ baseIntervalSeconds: 300, consecutiveFailures: 1000, now }).delaySeconds,
    ).toBe(86400);
  });
});
