$ErrorActionPreference = 'Stop'
$compose = @('compose', '--project-name', 'sazuz', '--file', (Join-Path $PSScriptRoot 'deploy/compose.yaml'))
$bundle = Join-Path $PSScriptRoot 'deploy/compose.release.yaml'
if (Test-Path -LiteralPath $bundle) { $compose += @('--file', $bundle) }
$config = Join-Path $PSScriptRoot 'data/compose.install.yaml'
if (Test-Path -LiteralPath $config) { $compose += @('--file', $config) }
$release = Join-Path $PSScriptRoot 'data/compose.release.yaml'
if (Test-Path -LiteralPath $release) { $compose += @('--file', $release) }
if ($args.Count -gt 0 -and $args[0] -in @('backup','restore','update')) {
  . (Join-Path $PSScriptRoot 'deploy/host-ops.ps1')
  try { Invoke-SazuzOperation -Root $PSScriptRoot -Compose $compose -InputArguments $args; exit 0 }
  catch { Write-Error 'The operation stopped. Inspect Settings > Backups/Updates. For interrupted updates, run sazuz update recover.' -ErrorAction Continue; exit 1 }
}
& docker @compose exec server node /app/dist/cli.js @args
exit $LASTEXITCODE
