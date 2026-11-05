import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandSchema, runCli } from './commands.js';
const server = vi.hoisted(() => ({ url: 'http://127.0.0.1:7778' }));
vi.mock('@sazuz/config', () => ({
  readInfraConfig: () => ({ serverUrl: server.url, dataDir: '/private' }),
  readPlumbing: () => Promise.resolve({ operatorKey: 'test-operator-key' }),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  server.url = 'http://127.0.0.1:7778';
});
describe('operator CLI boundaries', () => {
  it('rejects command-line secrets and unknown operations', () => {
    expect(commandSchema.safeParse(['unlock', 'secret-on-command-line']).success).toBe(false);
    expect(commandSchema.safeParse(['delete-everything']).success).toBe(false);
    expect(commandSchema.safeParse(['pause', 'secret-on-command-line']).success).toBe(false);
  });
  it('reports real health and fails on a degraded worker', async () => {
    const output = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            status: 'degraded',
            checkedAt: new Date().toISOString(),
            services: {
              database: { status: 'ok', latencyMs: 1 },
              worker: { status: 'missing', activeCount: 0, lastSeenAt: null },
            },
          },
          { status: 503 },
        ),
      ),
    );
    await expect(runCli(['doctor'], vi.fn(), output)).rejects.toThrow('needs attention');
    expect(output).toHaveBeenCalledWith('Database: ok; worker: missing.');
  });
  it('uses local operator authorization and never prints an unlock credential', async () => {
    const output = vi.fn();
    const request = vi.fn().mockResolvedValue(
      Response.json({
        initialized: true,
        locked: false,
        mode: 'strict',
        recoveryConfirmed: true,
      }),
    );
    vi.stubGlobal('fetch', request);
    await runCli(['unlock'], () => Promise.resolve('private-vault-passphrase'), output);
    expect(request).toHaveBeenCalledOnce();
    const [, options] = request.mock.calls[0] as [URL, RequestInit];
    expect(options.headers).toMatchObject({ authorization: 'Bearer test-operator-key' });
    expect(output).toHaveBeenCalledWith('Vault unlocked.');
    expect(JSON.stringify(output.mock.calls)).not.toContain('private-vault-passphrase');
  });
  it('requires matching strong reset passwords before sending a request', async () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    const prompt = vi
      .fn()
      .mockResolvedValueOnce('new-admin-password-9145')
      .mockResolvedValueOnce('different-password-123');
    await expect(runCli(['reset-admin'], prompt, vi.fn())).rejects.toThrow('do not match');
    expect(request).not.toHaveBeenCalled();
  });
  it('reports reset success only after a valid successful response', async () => {
    const output = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ok: true })));
    await runCli(['reset-admin'], () => Promise.resolve('new-admin-password-9145'), output);
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining('Existing sessions and two-factor enrollment were revoked'),
    );
  });
  it('pauses through the versioned local operator API without prompting or printing credentials', async () => {
    const output = vi.fn(),
      prompt = vi.fn();
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ paused: false, version: 7, updatedAt: new Date().toISOString() }),
      )
      .mockResolvedValueOnce(
        Response.json({ paused: true, version: 8, updatedAt: new Date().toISOString() }),
      );
    vi.stubGlobal('fetch', request);
    await runCli(['pause'], prompt, output);
    expect(prompt).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
    const [url, read] = request.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('http://127.0.0.1:7778/api/operator/control');
    expect(read.headers).toMatchObject({ authorization: 'Bearer test-operator-key' });
    const [, write] = request.mock.calls[1] as [URL, RequestInit];
    expect(write.method).toBe('POST');
    expect(write.body).toBe(JSON.stringify({ paused: true, version: 7 }));
    expect(write.redirect).toBe('error');
    expect(output).toHaveBeenCalledWith('All agents paused. In-flight actions are stopping.');
    expect(JSON.stringify(output.mock.calls)).not.toContain('test-operator-key');
  });
  it('clears only the global kill switch on resume and treats a matching state as a no-op', async () => {
    const output = vi.fn(),
      prompt = vi.fn();
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ paused: true, version: 4, updatedAt: new Date().toISOString() }),
      )
      .mockResolvedValueOnce(
        Response.json({ paused: false, version: 5, updatedAt: new Date().toISOString() }),
      )
      .mockResolvedValueOnce(
        Response.json({ paused: false, version: 5, updatedAt: new Date().toISOString() }),
      );
    vi.stubGlobal('fetch', request);
    await runCli(['resume'], prompt, output);
    await runCli(['resume'], prompt, output);
    expect(prompt).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(3);
    expect((request.mock.calls[1] as [URL, RequestInit])[1].body).toBe(
      JSON.stringify({ paused: false, version: 4 }),
    );
    expect(output).toHaveBeenNthCalledWith(
      1,
      'Global pause cleared. Runs paused by the kill switch can resume.',
    );
    expect(output).toHaveBeenNthCalledWith(2, 'The global kill switch is already clear.');
  });
  it('reloads a conflicting control version before retrying', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ paused: false, version: 1, updatedAt: new Date().toISOString() }),
      )
      .mockResolvedValueOnce(
        Response.json({ error: { code: 'MISSION_CONFLICT' } }, { status: 409 }),
      )
      .mockResolvedValueOnce(
        Response.json({ paused: false, version: 3, updatedAt: new Date().toISOString() }),
      )
      .mockResolvedValueOnce(
        Response.json({ paused: true, version: 4, updatedAt: new Date().toISOString() }),
      );
    vi.stubGlobal('fetch', request);
    await runCli(['pause'], vi.fn(), vi.fn());
    expect(request).toHaveBeenCalledTimes(4);
    expect((request.mock.calls[3] as [URL, RequestInit])[1].body).toBe(
      JSON.stringify({ paused: true, version: 3 }),
    );
  });
  it('bounds conflict retries and never claims success after denied or malformed responses', async () => {
    const output = vi.fn();
    const conflict = vi.fn((_url: URL, init: RequestInit) =>
      Promise.resolve(
        init.method === 'POST'
          ? Response.json({}, { status: 409 })
          : Response.json({ paused: false, version: 2, updatedAt: new Date().toISOString() }),
      ),
    );
    vi.stubGlobal('fetch', conflict);
    await expect(runCli(['pause'], vi.fn(), output)).rejects.toThrow('changed repeatedly');
    expect(conflict).toHaveBeenCalledTimes(6);
    for (const response of [
      Response.json({ error: 'private-error-canary' }, { status: 403 }),
      Response.json({ paused: 'invalid' }),
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      await expect(runCli(['pause'], vi.fn(), output)).rejects.toThrow();
    }
    expect(output).not.toHaveBeenCalled();
  });
  it('rejects remote operator destinations before sending the private credential', async () => {
    server.url = 'https://remote.example.test';
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    await expect(runCli(['pause'], vi.fn(), vi.fn())).rejects.toThrow('local Sazuz server');
    expect(request).not.toHaveBeenCalled();
  });
});
