param([switch]$NoOpen, [switch]$NoPathUpdate)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Install Docker Desktop from https://docs.docker.com/desktop/setup/install/windows-install/ and rerun this installer.' }
& docker compose version
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose is required.' }
& docker info *> $null
if ($LASTEXITCODE -ne 0) { throw 'Start Docker Desktop and rerun this installer.' }
$data = Join-Path $root 'data'
if (Test-Path -LiteralPath $data) {
  $item = Get-Item -LiteralPath $data -Force
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'The data directory must be a regular directory.' }
} else { New-Item -ItemType Directory -Path $data | Out-Null }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $data
if (@($identity.Value, 'S-1-5-18', 'S-1-5-32-544') -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'The data directory has an unexpected owner.' }
$needsProtection = -not $acl.AreAccessRulesProtected
foreach ($existing in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($existing.AccessControlType -eq 'Allow' -and @($identity.Value, 'S-1-5-18', 'S-1-5-32-544') -notcontains $existing.IdentityReference.Value) { $needsProtection = $true }
}
if ($needsProtection) {
$acl.SetAccessRuleProtection($true, $false)
foreach ($existing in $acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier])) { $acl.RemoveAccessRuleSpecific($existing) }
foreach ($sid in @($identity.Value, 'S-1-5-18', 'S-1-5-32-544')) {
  $account = New-Object Security.Principal.SecurityIdentifier($sid)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($account, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $data -AclObject $acl
}
$config = Join-Path $data 'compose.install.yaml'
if (Test-Path -LiteralPath $config) {
  $item = Get-Item -LiteralPath $config -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe install configuration.' }
  $match = [regex]::Match((Get-Content -LiteralPath $config -Raw), 'SAZUZ_WEB_PORT: "(\d+)"')
  if (-not $match.Success) { throw 'Generated install configuration is invalid.' }
  $port = [int]$match.Groups[1].Value
  if ($port -lt 7777 -or $port -gt 7797) { throw 'Generated install port is invalid.' }
} else {
  $port = 7777
  while ($port -le 7797) {
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $port)
    try { $listener.Start(); $listener.Stop(); break } catch { $listener.Stop(); $port++ }
  }
  if ($port -gt 7797) { throw 'No available port in 7777-7797.' }
  @"
services:
  web:
    ports: !override
      - "127.0.0.1:${port}:7777"
  server:
    environment:
      SAZUZ_WEB_PORT: "$port"
"@ | Set-Content -LiteralPath $config -Encoding ascii
}
$compose = @('compose', '--project-name', 'sazuz', '--file', (Join-Path $root 'deploy/compose.yaml'))
$bundle = Join-Path $root 'deploy/compose.release.yaml'
if (Test-Path -LiteralPath $bundle) {
  $item = Get-Item -LiteralPath $bundle -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe bundled release configuration.' }
  $compose += @('--file', $bundle)
}
$compose += @('--file', $config)
$release = Join-Path $data 'compose.release.yaml'
if (Test-Path -LiteralPath $release) {
  $item = Get-Item -LiteralPath $release -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe release configuration.' }
  $compose += @('--file', $release)
  & docker @compose up --detach --no-build --pull never --wait --wait-timeout 240
} elseif (Test-Path -LiteralPath $bundle) {
  & docker @compose up --detach --no-build --pull missing --wait --wait-timeout 240
} else { & docker @compose up --detach --build --wait --wait-timeout 240 }
if ($LASTEXITCODE -ne 0) { throw 'Sazuz did not become healthy. Inspect docker compose logs and rerun; existing data is preserved.' }
& docker @compose exec -T server node /app/dist/cli.js setup-token
if ($LASTEXITCODE -ne 0) { throw 'Could not read the setup token. Run .\sazuz.ps1 setup-token after the server starts.' }
$bin = Join-Path $env:LOCALAPPDATA 'Sazuz/bin'
New-Item -ItemType Directory -Path $bin -Force | Out-Null
$escaped = (Join-Path $root 'sazuz.ps1').Replace("'", "''")
"& '$escaped' @args" | Set-Content -LiteralPath (Join-Path $bin 'sazuz.ps1') -Encoding utf8
'@echo off' + "`r`n" + 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0sazuz.ps1" %*' | Set-Content -LiteralPath (Join-Path $bin 'sazuz.cmd') -Encoding ascii
if (-not $NoPathUpdate) {
  $userPath = [string][Environment]::GetEnvironmentVariable('Path', 'User')
  if (($userPath -split ';') -notcontains $bin) { [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $bin).TrimStart(';'), 'User') }
  Write-Host 'The sazuz command will be available in new terminals.'
}
$url = "http://localhost:$port/setup"
Write-Host "Open $url"
Write-Host "CLI: & '$bin/sazuz.ps1' doctor"
if (-not $NoOpen) { Start-Process $url }
