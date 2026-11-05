import { expect, it, vi } from 'vitest';
import { notifyLocal, type runFixedCommand } from './commands.js';

it('keeps notification text out of executable source and option parsing on every desktop backend', async () => {
  const run = vi
    .fn<typeof runFixedCommand>()
    .mockResolvedValue({ exitCode: 0, output: '', truncated: false });
  const title = '-e',
    message = 'do shell script "untrusted notification text"; $(untrusted)',
    signal = new AbortController().signal;
  await expect(notifyLocal(title, message, signal, { platform: 'darwin', run })).resolves.toEqual({
    submitted: true,
  });
  const mac = run.mock.calls[0]!;
  expect(mac[0]).toBe('/usr/bin/osascript');
  expect(mac[1].slice(-3)).toEqual(['--', title, message]);
  expect(mac[1][1]).not.toContain(message);
  run.mockClear();
  await notifyLocal(title, message, signal, { platform: 'win32', run });
  const windows = run.mock.calls[0]!;
  expect(JSON.parse(windows[4]!)).toEqual({ title, message });
  const source = Buffer.from(windows[1].at(-1)!, 'base64').toString('utf16le');
  expect(source).not.toContain(message);
  expect(source).toContain('[Console]::In.ReadToEnd() | ConvertFrom-Json');
  run.mockClear();
  await notifyLocal(title, message, signal, { platform: 'linux', run });
  expect(run.mock.calls[0]![1]).toEqual(['--', title, message]);
  run.mockResolvedValueOnce({ exitCode: 1, output: '', truncated: false });
  await expect(
    notifyLocal(title, message, signal, { platform: 'linux', run }),
  ).rejects.toMatchObject({ code: 'BRIDGE_UNAVAILABLE' });
});
