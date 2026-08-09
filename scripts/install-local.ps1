[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string[]]$InstallerArguments = @()
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js 18 or later is required.'
}
& node (Join-Path $root 'scripts\install-local.mjs') @InstallerArguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
