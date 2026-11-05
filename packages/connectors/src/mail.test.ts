import { ImapFlow, type FetchMessageObject, type ImapFlowOptions } from 'imapflow';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorAccount } from './contracts.js';
import { officialMailTransport } from './mail.js';

const wire = vi.hoisted(() => ({
  imap: {
    mailbox: { exists: 0, uidNext: 1, uidValidity: 1n },
    connect: vi.fn<() => Promise<void>>(),
    getMailboxLock: vi.fn<ImapFlow['getMailboxLock']>(),
    fetchAll: vi.fn<ImapFlow['fetchAll']>(),
    fetchOne: vi.fn<ImapFlow['fetchOne']>(),
    search: vi.fn<ImapFlow['search']>(),
    close: vi.fn<() => void>(),
    on: vi.fn<(event: 'error', listener: () => void) => void>(),
  },
  release: vi.fn<() => void>(),
  smtp: {
    sendMail:
      vi.fn<
        (
          options: SendMailOptions,
        ) => Promise<{ messageId: string; accepted: string[]; rejected: string[] }>
      >(),
    close: vi.fn<() => void>(),
  },
}));

vi.mock('imapflow', () => ({
  ImapFlow: vi.fn(function (_options: ImapFlowOptions) {
    return wire.imap;
  }),
}));
vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => wire.smtp) },
}));

const account: ConnectorAccount = {
  id: 'mail-account',
  name: 'Mail',
  kind: 'email',
  provider: 'imap-smtp',
  mode: 'read-write',
  scopes: ['email:read', 'email:send'],
  secretRef: 'secret://mail-password',
  options: {
    email: 'sender@example.com',
    imapHost: 'imap.example.com',
    smtpHost: 'smtp.example.com',
    sentMailbox: 'Sent',
  },
};
const password = 'mail-transport-fixture-password-26472845';
const messageId = '<sazuz-operation@id.sazuz.local>';
const input = () => ({ account, password, signal: new AbortController().signal });
const envelope = (
  uid: number,
  source = 'Content-Type: text/plain; charset=UTF-8\r\n\r\nHello',
): FetchMessageObject => ({
  seq: uid,
  uid,
  source: Buffer.from(source),
  size: Buffer.byteLength(source),
  internalDate: new Date('2026-11-03T10:00:00Z'),
  envelope: {
    messageId: `<mail-${uid}@example.com>`,
    subject: 'Incoming message',
    from: [{ address: 'reader@example.com' }],
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  wire.imap.mailbox = { exists: 4, uidNext: 103, uidValidity: 502n };
  wire.imap.connect.mockReset().mockResolvedValue();
  wire.imap.getMailboxLock.mockReset().mockResolvedValue({ path: 'INBOX', release: wire.release });
  wire.imap.fetchAll.mockReset().mockResolvedValue([]);
  wire.imap.fetchOne.mockReset().mockResolvedValue(false);
  wire.imap.search.mockReset().mockResolvedValue([]);
  wire.smtp.sendMail
    .mockReset()
    .mockResolvedValue({ messageId, accepted: ['recipient@example.net'], rejected: [] });
});

describe('official IMAP transport', () => {
  it('negotiates verified TLS, disables wire logging, and reads bounded previews without Seen writes', async () => {
    wire.imap.fetchAll.mockResolvedValue([envelope(101), { ...envelope(102), size: 20_000 }]);
    const result = await officialMailTransport.list({ ...input(), mailbox: 'INBOX', limit: 2 });
    expect(ImapFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'imap.example.com',
        port: 993,
        secure: true,
        doSTARTTLS: false,
        auth: { user: account.options.email, pass: password },
        tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
        logger: false,
        logRaw: false,
        emitLogs: false,
        disableCompression: true,
        maxLiteralSize: 131_072,
        maxResponseSize: 262_144,
      }),
    );
    expect(wire.imap.getMailboxLock).toHaveBeenCalledWith('INBOX', { readOnly: true });
    expect(wire.imap.fetchAll).toHaveBeenCalledWith(
      '3:4',
      expect.objectContaining({ uid: true, source: { start: 0, maxLength: 8192 } }),
      { uid: false },
    );
    expect(result.uidValidity).toBe('502');
    expect(result.hasMore).toBe(true);
    expect(result.messages[0]).toMatchObject({
      uid: 101,
      text: 'Hello',
      from: 'reader@example.com',
    });
    expect(result.messages[1]?.text).toContain('[Message preview truncated]');
    expect(wire.release).toHaveBeenCalledOnce();
    expect(wire.imap.close).toHaveBeenCalledOnce();
  });

  it('requires STARTTLS on non-implicit-TLS accounts and advances sparse UID windows', async () => {
    const result = await officialMailTransport.list({
      ...input(),
      account: { ...account, options: { ...account.options, imapSecure: false } },
      mailbox: 'INBOX',
      afterUid: 40,
      uidValidity: '502',
      limit: 20,
    });
    expect(ImapFlow).toHaveBeenCalledWith(
      expect.objectContaining({ port: 143, secure: false, doSTARTTLS: true }),
    );
    expect(wire.imap.fetchAll).toHaveBeenCalledWith('41:60', expect.anything(), { uid: true });
    expect(result).toEqual({ uidValidity: '502', messages: [], scannedThrough: 60, hasMore: true });
  });

  it('resets the UID window after UIDVALIDITY changes and avoids fetching exhausted ranges', async () => {
    const result = await officialMailTransport.list({
      ...input(),
      mailbox: 'INBOX',
      afterUid: 1000,
      uidValidity: '501',
      limit: 10,
    });
    expect(wire.imap.fetchAll).toHaveBeenCalledWith('1:10', expect.anything(), { uid: true });
    expect(result.scannedThrough).toBe(10);
    wire.imap.fetchAll.mockClear();
    expect(
      await officialMailTransport.list({
        ...input(),
        mailbox: 'INBOX',
        afterUid: 102,
        uidValidity: '502',
        limit: 10,
      }),
    ).toEqual({ uidValidity: '502', messages: [], hasMore: false, scannedThrough: 102 });
    expect(wire.imap.fetchAll).not.toHaveBeenCalled();
  });

  it('extracts multipart text while excluding attachments and uses a bounded UID read', async () => {
    const source = [
      'Content-Type: multipart/mixed; boundary="message-part"',
      '',
      '--message-part',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Caf=C3=A9',
      '--message-part',
      'Content-Type: text/plain',
      'Content-Disposition: attachment; filename="secret.txt"',
      '',
      'ATTACHMENT MUST STAY UNREAD',
      '--message-part--',
      '',
    ].join('\r\n');
    wire.imap.fetchOne.mockResolvedValue(envelope(91, source));
    const result = await officialMailTransport.read({ ...input(), mailbox: 'Archive', uid: 91 });
    expect(result.text).toContain('Café');
    expect(result.text).not.toContain('ATTACHMENT');
    expect(wire.imap.getMailboxLock).toHaveBeenCalledWith('Archive', { readOnly: true });
    expect(wire.imap.fetchOne).toHaveBeenCalledWith(
      '91',
      expect.objectContaining({ source: { start: 0, maxLength: 131_072 } }),
      { uid: true },
    );
    expect(wire.release).toHaveBeenCalledOnce();
  });

  it('reconciles only one exact Message-ID, since IMAP header search is a substring match', async () => {
    wire.imap.search.mockResolvedValue([91]);
    wire.imap.fetchOne.mockResolvedValue({ ...envelope(91), envelope: { messageId } });
    expect(
      await officialMailTransport.findSent({ ...input(), mailbox: 'Sent', messageId }),
    ).toEqual({ uid: 91 });
    expect(wire.imap.search).toHaveBeenCalledWith(
      { header: { 'message-id': messageId } },
      { uid: true },
    );
    wire.imap.fetchOne.mockResolvedValue({
      ...envelope(91),
      envelope: { messageId: `extra${messageId}` },
    });
    expect(
      await officialMailTransport.findSent({ ...input(), mailbox: 'Sent', messageId }),
    ).toBeNull();
    wire.imap.search.mockResolvedValue([91, 92]);
    wire.imap.fetchOne.mockClear();
    expect(
      await officialMailTransport.findSent({ ...input(), mailbox: 'Sent', messageId }),
    ).toBeNull();
    expect(wire.imap.fetchOne).not.toHaveBeenCalled();
  });

  it('releases locks and closes sockets after a malformed response or provider failure', async () => {
    wire.imap.fetchAll.mockResolvedValue([envelope(1), envelope(2)]);
    await expect(
      officialMailTransport.list({ ...input(), mailbox: 'INBOX', limit: 1 }),
    ).rejects.toMatchObject({ connectorCode: 'INVALID_RESPONSE' });
    expect(wire.release).toHaveBeenCalledOnce();
    expect(wire.imap.close).toHaveBeenCalledOnce();
    wire.imap.fetchAll.mockRejectedValue(new Error(`Provider password=${password}`));
    await expect(
      officialMailTransport.list({ ...input(), mailbox: 'INBOX', limit: 1 }),
    ).rejects.toMatchObject({
      connectorCode: 'TRANSPORT_FAILED',
      message: 'The tool could not complete the operation.',
    });
    expect(wire.release).toHaveBeenCalledTimes(2);
    expect(wire.imap.close).toHaveBeenCalledTimes(2);
  });

  it('closes an in-flight connection on cancellation and handles delayed socket errors', async () => {
    wire.imap.connect.mockImplementation(() => new Promise<void>(() => undefined));
    const controller = new AbortController();
    const operation = officialMailTransport.list({
      ...input(),
      signal: controller.signal,
      mailbox: 'INBOX',
      limit: 1,
    });
    controller.abort();
    await expect(operation).rejects.toMatchObject({ code: 'TOOL_ABORTED' });
    expect(wire.imap.close).toHaveBeenCalled();
    expect(wire.imap.getMailboxLock).not.toHaveBeenCalled();
    const onError = wire.imap.on.mock.calls.find(([event]) => event === 'error')?.[1];
    expect(onError).toBeDefined();
    expect(() => onError?.()).not.toThrow();
  });
});

describe('official SMTP transport', () => {
  const message = {
    to: ['recipient@example.net'],
    cc: ['copy@example.net'],
    subject: 'Build ready',
    text: 'Ready for review.',
  };

  it('sends the deterministic Message-ID over verified TLS with file and URL expansion disabled', async () => {
    const result = await officialMailTransport.send({ ...input(), message, messageId });
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.example.com',
        port: 465,
        secure: true,
        requireTLS: false,
        auth: { user: account.options.email, pass: password },
        tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
        logger: false,
        debug: false,
        disableFileAccess: true,
        disableUrlAccess: true,
      }),
    );
    expect(wire.smtp.sendMail).toHaveBeenCalledExactlyOnceWith({
      ...message,
      from: account.options.email,
      messageId,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    expect(result).toEqual({ messageId, accepted: ['recipient@example.net'], rejected: [] });
    expect(wire.smtp.close).toHaveBeenCalledOnce();
  });

  it('requires STARTTLS on submission port 587 and retains partial-recipient rejection', async () => {
    wire.smtp.sendMail.mockResolvedValue({
      messageId,
      accepted: ['recipient@example.net'],
      rejected: ['copy@example.net'],
    });
    const result = await officialMailTransport.send({
      ...input(),
      account: { ...account, options: { ...account.options, smtpSecure: false } },
      message,
      messageId,
    });
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 587, secure: false, requireTLS: true }),
    );
    expect(result.rejected).toEqual(['copy@example.net']);
  });

  it('closes stalled SMTP operations when cancelled and suppresses provider failure details', async () => {
    wire.smtp.sendMail.mockRejectedValueOnce(new Error(`SMTP AUTH failed: ${password}`));
    await expect(
      officialMailTransport.send({ ...input(), message, messageId }),
    ).rejects.toMatchObject({
      connectorCode: 'TRANSPORT_FAILED',
      message: 'The tool could not complete the operation.',
    });
    expect(wire.smtp.close).toHaveBeenCalledOnce();
    wire.smtp.sendMail.mockImplementation(() => new Promise(() => undefined));
    const controller = new AbortController();
    const operation = officialMailTransport.send({
      ...input(),
      signal: controller.signal,
      message,
      messageId,
    });
    controller.abort();
    await expect(operation).rejects.toMatchObject({ code: 'TOOL_ABORTED' });
    expect(wire.smtp.close).toHaveBeenCalledTimes(3);
  });

  it('does not initialize transports for a cancelled call or incomplete account configuration', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      officialMailTransport.send({ ...input(), signal: controller.signal, message, messageId }),
    ).rejects.toMatchObject({ code: 'TOOL_ABORTED' });
    await expect(
      officialMailTransport.send({
        ...input(),
        account: { ...account, options: { email: 'sender@example.com' } },
        message,
        messageId,
      }),
    ).rejects.toMatchObject({ connectorCode: 'ACCOUNT_UNAVAILABLE' });
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });
});
