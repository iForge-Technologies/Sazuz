import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { validateDataDir } from './infra.js';

type PrivateFileErrorCode = 'MISSING' | 'INVALID' | 'UNSAFE' | 'IO';

export class PrivateFileError extends Error {
  constructor(readonly code: PrivateFileErrorCode) {
    super('Private infrastructure files could not be accessed safely.');
    this.name = 'PrivateFileError';
  }
}

export interface PrivateFileSpec {
  name: string;
  maxBytes: number;
  optional?: boolean;
}

const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
const nonBlocking = process.platform === 'win32' ? 0 : constants.O_NONBLOCK;

// The script is fixed source, never assembled from a path or secret. Paths arrive
// as JSON on stdin; errors and PowerShell diagnostics never reach application logs.
const permissionScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $allowed = @($identity.Value, 'S-1-5-18', 'S-1-5-32-544')
  foreach ($path in $request.paths) {
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 2 }
    $acl = Get-Acl -LiteralPath $path
    if ($allowed -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { exit 2 }
    $needsProtection = -not $acl.AreAccessRulesProtected
    foreach ($existing in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
      if ($existing.AccessControlType -eq 'Allow' -and $allowed -notcontains $existing.IdentityReference.Value) { $needsProtection = $true }
    }
    if ($request.operation -eq 'protect' -and $needsProtection) {
      $private = $acl
      $private.SetAccessRuleProtection($true, $false)
      foreach ($existing in $private.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier])) {
        $private.RemoveAccessRuleSpecific($existing)
      }
      foreach ($sidValue in $allowed) {
        $sid = New-Object System.Security.Principal.SecurityIdentifier($sidValue)
        if ($item.PSIsContainer) {
          $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
        } else {
          $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
        }
        $private.AddAccessRule($rule)
      }
      Set-Acl -LiteralPath $path -AclObject $private
      $acl = Get-Acl -LiteralPath $path
    }
    foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -eq 'Allow' -and $allowed -notcontains $rule.IdentityReference.Value) { exit 2 }
    }
  }
  [Console]::Out.Write('ok')
  exit 0
} catch { exit 3 }
`;

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function safeError(error: unknown): PrivateFileError {
  if (error instanceof PrivateFileError) return error;
  if (hasCode(error, 'ENOENT')) return new PrivateFileError('MISSING');
  if (hasCode(error, 'ELOOP') || hasCode(error, 'ENOTDIR')) return new PrivateFileError('UNSAFE');
  return new PrivateFileError('IO');
}

function filename(dataDir: string, name: string): string {
  if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(name)) throw new PrivateFileError('UNSAFE');
  return join(validateDataDir(dataDir), 'secrets', name);
}

async function windowsPermissions(paths: readonly string[], operation: 'protect' | 'assert') {
  if (process.platform !== 'win32') return;
  const executable = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32/WindowsPowerShell/v1.0/powershell.exe',
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      executable,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(permissionScript, 'utf16le').toString('base64'),
      ],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, timeout: 10_000 },
    );
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.once('error', () => reject(new PrivateFileError('IO')));
    child.stdin.on('error', () => reject(new PrivateFileError('IO')));
    child.once('close', (code) => {
      if (code === 0 && output === 'ok') resolve();
      else reject(new PrivateFileError(code === 2 ? 'UNSAFE' : 'IO'));
    });
    child.stdin.end(JSON.stringify({ operation, paths }));
  });
}

function assertOwner(stats: Stats): void {
  if (
    process.platform !== 'win32' &&
    process.getuid !== undefined &&
    stats.uid !== process.getuid()
  ) {
    throw new PrivateFileError('UNSAFE');
  }
}

async function assertDirectory(path: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new PrivateFileError('UNSAFE');
  if (process.platform !== 'win32') {
    assertOwner(stats);
    if ((stats.mode & 0o7777) !== 0o700) throw new PrivateFileError('UNSAFE');
  }
}

function assertFile(stats: Stats, maxBytes: number): void {
  if (!stats.isFile() || stats.isSymbolicLink()) throw new PrivateFileError('UNSAFE');
  if (process.platform !== 'win32') {
    assertOwner(stats);
    if ((stats.mode & 0o7177) !== 0 || (stats.mode & 0o400) === 0)
      throw new PrivateFileError('UNSAFE');
  }
  if (stats.size > maxBytes) throw new PrivateFileError('INVALID');
}

/** Protect directories before creating even a temporary secret file. */
export async function preparePrivateSecretDirectory(dataDir: string): Promise<string> {
  try {
    const root = validateDataDir(dataDir);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await assertDirectory(root);
    const secrets = join(root, 'secrets');
    await mkdir(secrets, { recursive: true, mode: 0o700 });
    await assertDirectory(secrets);
    await windowsPermissions([root, secrets], 'protect');
    return secrets;
  } catch (error) {
    throw safeError(error);
  }
}

/** Batch Windows ACL inspection, then bounded no-follow reads with inode checks. */
export async function readPrivateFiles(
  dataDir: string,
  specs: readonly PrivateFileSpec[],
): Promise<Map<string, Buffer>> {
  try {
    const root = validateDataDir(dataDir);
    const secrets = join(root, 'secrets');
    await assertDirectory(root);
    await assertDirectory(secrets);
    const found = new Map<string, { path: string; before: Stats; maxBytes: number }>();
    for (const spec of specs) {
      if (!Number.isSafeInteger(spec.maxBytes) || spec.maxBytes < 1 || spec.maxBytes > 65_536)
        throw new PrivateFileError('INVALID');
      const path = filename(root, spec.name);
      try {
        const before = await lstat(path);
        assertFile(before, spec.maxBytes);
        found.set(spec.name, { path, before, maxBytes: spec.maxBytes });
      } catch (error) {
        if (!(spec.optional === true && hasCode(error, 'ENOENT'))) throw error;
      }
    }
    await windowsPermissions(
      [root, secrets, ...[...found.values()].map(({ path }) => path)],
      'assert',
    );
    const result = new Map<string, Buffer>();
    for (const [name, { path, before, maxBytes }] of found) {
      const handle = await open(path, constants.O_RDONLY | noFollow | nonBlocking);
      try {
        const opened = await handle.stat();
        assertFile(opened, maxBytes);
        if (opened.dev !== before.dev || opened.ino !== before.ino)
          throw new PrivateFileError('UNSAFE');
        const buffer = Buffer.alloc(maxBytes + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > maxBytes) throw new PrivateFileError('INVALID');
        result.set(name, buffer.subarray(0, bytesRead));
      } finally {
        await handle.close();
      }
    }
    return result;
  } catch (error) {
    throw safeError(error);
  }
}

/** Existing files are never replaced; racing processes publish one complete inode. */
export async function claimPrivateFile(
  dataDir: string,
  name: string,
  content: Uint8Array,
): Promise<boolean> {
  let created = false;
  try {
    const target = filename(dataDir, name);
    const directory = join(validateDataDir(dataDir), 'secrets');
    await assertDirectory(validateDataDir(dataDir));
    await assertDirectory(directory);
    const temporary = join(directory, `.sazuz-${randomUUID()}.tmp`);
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    try {
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(temporary, target);
        created = true;
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error;
      }
    } finally {
      await unlink(temporary);
    }
    if (process.platform !== 'win32') {
      const handle = await open(directory, constants.O_RDONLY | noFollow);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    return created;
  } catch (error) {
    throw safeError(error);
  }
}

export async function writePrivateFileOnce(
  dataDir: string,
  name: string,
  content: Uint8Array,
): Promise<void> {
  await claimPrivateFile(dataDir, name, content);
}

export async function removePrivateFile(dataDir: string, name: string): Promise<void> {
  try {
    await readPrivateFiles(dataDir, [{ name, maxBytes: 65_536, optional: true }]);
    try {
      await unlink(filename(dataDir, name));
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
  } catch (error) {
    throw safeError(error);
  }
}
