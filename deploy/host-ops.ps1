# Trusted host operations. Docker remains on the host; application containers never receive its socket.
function Invoke-SazuzOperation {
  param([string]$Root, [string[]]$Compose, [string[]]$InputArguments)
  $ErrorActionPreference = 'Stop'
  function Invoke-Docker([string[]]$Vector) {
    $result = @(& docker @Vector)
    if ($LASTEXITCODE -ne 0) { throw 'A fixed Docker operation failed.' }
    return ($result -join "`n").Trim()
  }
  function Assert-Regular([string]$Path) {
    if (Test-Path -LiteralPath $Path) {
      $item = Get-Item -LiteralPath $Path -Force
      if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe operation path.' }
    }
  }
  # Microsoft argv quoting, passed directly to an executable with UseShellExecute=false.
  function Quote-Argument([string]$Value) {
    $encoded = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $encoded = [regex]::Replace($encoded, '(\\+)$', '$1$1')
    return '"' + $encoded + '"'
  }
  function Stream-Docker([string[]]$Vector, [string]$InputPath, [string]$OutputPath) {
    $process = New-Object Diagnostics.Process
    $process.StartInfo.FileName = (Get-Command docker -CommandType Application).Source
    $process.StartInfo.Arguments = (($Vector | ForEach-Object { Quote-Argument $_ }) -join ' ')
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardInput = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $source = $null; $destination = $null
    try {
      if ($InputPath) { $source = [IO.File]::OpenRead($InputPath) }
      if ($OutputPath) { $destination = [IO.File]::Open($OutputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) }
      $process.Start() | Out-Null
      if ($destination) { $read = $process.StandardOutput.BaseStream.CopyToAsync($destination) }
      else { $read = $process.StandardOutput.ReadToEndAsync() }
      if ($source) { $source.CopyTo($process.StandardInput.BaseStream) }
      $process.StandardInput.Close()
      $process.WaitForExit()
      $result = $read.GetAwaiter().GetResult()
      if ($process.ExitCode -ne 0) { throw 'Encrypted transfer failed.' }
      if (-not $destination) { return $result.Trim() }
    } finally {
      if ($source) { $source.Dispose() }; if ($destination) { $destination.Dispose() }
      $process.Dispose()
    }
  }
  if ($InputArguments.Count -ne 2) { throw 'Usage: sazuz backup file.sazuz | restore file.sazuz | update release.json | update recover' }
  $command = $InputArguments[0]; $argument = $InputArguments[1]
  if ($command -eq 'backup') {
    $target = [IO.Path]::GetFullPath($argument)
    if (Test-Path -LiteralPath $target) { throw 'The backup destination already exists.' }
    $temporary = $target + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
      Stream-Docker ($Compose + @('exec','-T','server','node','/app/dist/cli.js','backup','--stream')) '' $temporary
      [IO.File]::Move($temporary, $target)
      Write-Host "Encrypted backup saved to $target"
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary } }
    return
  }
  if ($command -eq 'restore') {
    $source = (Resolve-Path -LiteralPath $argument).Path
    Assert-Regular $source
    if ((Get-Item -LiteralPath $source).Length -gt 134283264) { throw 'Backup exceeds the supported size.' }
    $operation = Stream-Docker ($Compose + @('exec','-T','server','node','/app/dist/cli.js','restore-upload')) $source ''
    if ($operation -notmatch '^op_[0-9A-HJKMNP-TV-Z]{26}$') { throw 'Restore upload was not confirmed.' }
    & docker @Compose exec server node /app/dist/cli.js restore-complete $operation
    if ($LASTEXITCODE -ne 0) { throw 'Restore requires attention.' }
    return
  }
  $data = Join-Path $Root 'data'
  $directory = Get-Item -LiteralPath $data -Force
  if (-not $directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe operation directory.' }
  $previous = Join-Path $data 'compose.update.previous.yaml'
  $candidate = Join-Path $data 'compose.update.candidate.yaml'
  $active = Join-Path $data 'compose.release.yaml'
  $lockPath = Join-Path $data 'update.lock'
  foreach ($path in @($previous,$candidate,$active,$lockPath)) { Assert-Regular $path }
  $lock = New-Object IO.FileStream($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 4096, [IO.FileOptions]::DeleteOnClose)
  $roles = @('bootstrap','migrate','server','worker','web','docker-socket-proxy','egress-proxy')
  $services = @('server','worker','web','docker-socket-proxy','egress-proxy')
  function Write-Override([string]$Path, [string]$Image) {
    if ($Image -notmatch '^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9./:_-]+@sha256:[a-f0-9]{64})$') { throw 'An immutable image is required.' }
    Assert-Regular $Path
    $lines = @('services:')
    foreach ($role in $roles) { $lines += @("  ${role}:", "    image: '$Image'") }
    $temp = $Path + '.' + [guid]::NewGuid().ToString('N')
    [IO.File]::WriteAllText($temp, ($lines -join "`n") + "`n", (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temp -Destination $Path -Force
  }
  function Local-Step([string]$Stage) { Invoke-Docker ($Compose + @('--file',$previous,'run','--rm','--no-deps','--entrypoint','node','server','/app/dist/cli.js','update-local',$Stage)) }
  function Recover-Update {
    if (-not (Test-Path -LiteralPath $previous)) { throw 'The previous-image journal is missing.' }
    $state = Local-Step 'state'
    if ($state -eq 'none') { Write-Host 'No update needs recovery.'; return }
    if ($state -eq 'activation-intent') { $state = Local-Step 'reconcile' }
    if ($state -eq 'done') { Local-Step 'reconcile' | Out-Null; Write-Override $active (Local-Step 'candidate'); Write-Host 'The healthy update is active.'; return }
    if ($state -in @('preparing','aborted')) { Local-Step 'abort' | Out-Null; Write-Host 'Update preparation was cancelled before image changes.'; return }
    Invoke-Docker ($Compose + @('stop','--timeout','30') + $services) | Out-Host
    Local-Step 'rollback' | Out-Null
    Copy-Item -LiteralPath $previous -Destination $active -Force
    Invoke-Docker ($Compose + @('--file',$previous,'up','--detach','--no-deps','--no-build','--pull','never','--wait','--wait-timeout','120') + $services) | Out-Host
    Local-Step 'finish-rollback' | Out-Null
    Write-Host 'Previous image and snapshot restored. Review stopped work before resuming.'
  }
  $prepared = $false; $activating = $false
  try {
    if ($argument -eq 'recover') { Recover-Update; return }
    if (Test-Path -LiteralPath $previous) {
      $priorState = Local-Step 'state'
      if ($priorState -notin @('none','done','rolled-back','aborted')) { throw 'Recover the unfinished update before selecting another release.' }
    }
    $manifest = (Resolve-Path -LiteralPath $argument).Path
    Assert-Regular $manifest
    if ((Get-Item -LiteralPath $manifest).Length -gt 32768) { throw 'Release manifest is too large.' }
    $container = Invoke-Docker ($Compose + @('ps','--quiet','server'))
    if ($container -notmatch '^[a-f0-9]{12,64}$') { throw 'Start the installed server before updating.' }
    $image = Invoke-Docker @('inspect','--format','{{.Image}}',$container)
    Write-Override $previous $image
    $prepared = $true
    $nextImage = Stream-Docker ($Compose + @('exec','-T','server','node','/app/dist/cli.js','update-prepare','--stdin',$image)) $manifest ''
    Write-Override $candidate $nextImage
    Local-Step 'pulling' | Out-Null
    Invoke-Docker @('pull',$nextImage) | Out-Host
    Invoke-Docker ($Compose + @('stop','--timeout','30') + $services) | Out-Host
    Local-Step 'migrating' | Out-Null
    Invoke-Docker ($Compose + @('--file',$candidate,'run','--rm','--no-deps','migrate')) | Out-Host
    Local-Step 'checking' | Out-Null
    Invoke-Docker ($Compose + @('--file',$candidate,'up','--detach','--no-deps','--no-build','--pull','never','--wait','--wait-timeout','120') + $services) | Out-Host
    $activating = $true
    Invoke-Docker ($Compose + @('exec','-T','server','node','/app/dist/cli.js','update-activate')) | Out-Null
    Write-Override $active $nextImage
    Write-Host 'Update is healthy and active. Release notes are in Settings > Advanced > Updates.'
  } catch {
    if ($prepared -and -not $activating) { Recover-Update }
    throw
  } finally { $lock.Dispose() }
}
