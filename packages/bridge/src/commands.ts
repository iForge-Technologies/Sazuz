import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BridgeError } from '@sazuz/core/bridge';
import { secretRedactor } from '@sazuz/vault';
import { fingerprint, type LocalConfiguration } from './local-config.js';
import { checkSignal, scopedPath } from './filesystem.js';

function environment() {
  const windows = process.env.SystemRoot ?? 'C:\\Windows';
  return process.platform === 'win32'
    ? {
        SystemRoot: windows,
        WINDIR: windows,
        TEMP: tmpdir(),
        TMP: tmpdir(),
        PATH: join(windows, 'System32'),
      }
    : { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TMPDIR: tmpdir() };
}
export async function runFixedCommand(
  executable: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  input?: string,
  desktop = false,
) {
  checkSignal(signal);
  return new Promise<{ exitCode: number; output: string; truncated: boolean }>(
    (resolve, reject) => {
      const env: Record<string, string> = environment();
      if (desktop && process.platform !== 'win32')
        for (const key of [
          'DISPLAY',
          'WAYLAND_DISPLAY',
          'DBUS_SESSION_BUS_ADDRESS',
          'XDG_RUNTIME_DIR',
        ])
          if (process.env[key]) env[key] = process.env[key]!;
      const child = spawn(executable, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const parts: Buffer[] = [];
      let bytes = 0,
        failed = false,
        truncated = false;
      function stop() {
        failed = true;
        if (!child.pid) return;
        if (process.platform === 'win32') {
          const killer = spawn(
            join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide: true, stdio: 'ignore', timeout: 5000 },
          );
          killer.once('error', () => {
            child.kill();
          });
          killer.once('close', (code) => {
            if (code !== 0 && child.exitCode === null) child.kill();
          });
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
      }
      const timeout = setTimeout(stop, 20_000);
      signal.addEventListener('abort', stop, { once: true });
      const clean = () => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', stop);
      };
      for (const stream of [child.stdout, child.stderr])
        stream.on('data', (data: Buffer) => {
          const take = Math.min(4096 - bytes, data.length);
          if (take > 0) {
            parts.push(data.subarray(0, take));
            bytes += take;
          }
          if (take < data.length) {
            truncated = true;
            stop();
          }
        });
      child.once('error', () => {
        clean();
        reject(new BridgeError('BRIDGE_UNAVAILABLE'));
      });
      child.stdin.on('error', stop);
      child.once('close', (code) => {
        clean();
        if (failed || signal.aborted) reject(new BridgeError('BRIDGE_UNCERTAIN'));
        else
          resolve({
            exitCode: code ?? 1,
            output: secretRedactor.redactText(Buffer.concat(parts).toString('utf8')),
            truncated,
          });
      });
      child.stdin.end(input);
      if (signal.aborted) stop();
    },
  );
}
export async function executeCommand(
  config: LocalConfiguration,
  stateDir: string,
  alias: string,
  signal: AbortSignal,
) {
  const command = config.commands.find((item) => item.alias === alias);
  if (!command) throw new BridgeError('BRIDGE_DENIED');
  const scoped = await scopedPath(config, stateDir, command.folder, '');
  for (const pin of command.pins) {
    const current = await fingerprint(pin.path);
    if (current.sha256 !== pin.sha256) throw new BridgeError('BRIDGE_CHANGED');
  }
  checkSignal(signal);
  return runFixedCommand(command.executable, command.args, scoped.target, signal);
}

// Native APIs receive data on stdin/argv. No message is interpolated into executable source.
const windowsNotification = `
$ErrorActionPreference = 'Stop'
$icon = $null
$timer = $null
try {
  $value = [Console]::In.ReadToEnd() | ConvertFrom-Json
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $icon = New-Object System.Windows.Forms.NotifyIcon
  $icon.Icon = [System.Drawing.SystemIcons]::Information
  $icon.Text = 'Sazuz Bridge'
  $icon.Visible = $true
  $icon.ShowBalloonTip(8000, $value.title, $value.message, [System.Windows.Forms.ToolTipIcon]::Info)
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 9000
  $timer.Add_Tick({ [System.Windows.Forms.Application]::ExitThread() })
  $timer.Start()
  [System.Windows.Forms.Application]::Run()
} catch { exit 1 } finally {
  if ($null -ne $timer) { $timer.Dispose() }
  if ($null -ne $icon) { $icon.Visible = $false; $icon.Dispose() }
}
`;
export async function notifyLocal(
  title: string,
  message: string,
  signal: AbortSignal,
  {
    platform = process.platform,
    run = runFixedCommand,
  }: {
    platform?: NodeJS.Platform;
    run?: typeof runFixedCommand;
  } = {},
) {
  let result;
  if (platform === 'win32') {
    const executable = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    );
    result = await run(
      executable,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-EncodedCommand',
        Buffer.from(windowsNotification, 'utf16le').toString('base64'),
      ],
      dirname(executable),
      signal,
      JSON.stringify({ title, message }),
    );
  } else if (platform === 'darwin') {
    result = await run(
      '/usr/bin/osascript',
      [
        '-e',
        'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run',
        '--',
        title,
        message,
      ],
      '/tmp',
      signal,
      undefined,
      true,
    );
  } else {
    result = await run(
      '/usr/bin/notify-send',
      ['--', title, message],
      '/tmp',
      signal,
      undefined,
      true,
    );
  }
  if (result.exitCode !== 0) throw new BridgeError('BRIDGE_UNAVAILABLE');
  return { submitted: true };
}
