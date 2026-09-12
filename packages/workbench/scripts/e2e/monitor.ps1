# Thin wrapper around monitor.ts (the host-agnostic entry point).
#
# Credentials are read inside monitor.ts (env first, else DPAPI via bun:ffi), so this
# script no longer decrypts anything and no longer touches the parent session env.
#
# Measured 2026-09-12: the embedded PowerShell tool on this machine does not start
# native processes at all (the sandbox switch makes no difference and $LASTEXITCODE is
# never set), so from that host call monitor.ts directly with bun. This wrapper only
# exists for real interactive consoles.
#
# NOTE: keep this file ASCII-only (Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI).
param(
	[int]$Rounds = 0,
	[string]$Workspace,
	[string]$Out,
	[string]$FailOn = 'high',
	[string]$EvidenceKind = 'live-model',
	[switch]$Json,
	[switch]$NoAppend
)

$ErrorActionPreference = 'Stop'
# Native commands are exempt from that preference: under 5.1 a native process writing
# to stderr becomes a terminating NativeCommandError, so a caller that merges streams
# ("./monitor.ps1 -Rounds 3 2>&1 | ...") would kill the batch on the first progress
# line. Relax it around the call and check $LASTEXITCODE explicitly instead.
$nativePreference = $ErrorActionPreference

# Prefer a real bun executable over the npm shim (bun.ps1), whose behaviour depends on
# the host it is invoked from.
$bunExe = $null
$bunCommand = Get-Command bun -ErrorAction SilentlyContinue
if ($bunCommand) {
	$shimDir = Split-Path $bunCommand.Source -Parent
	$bunCandidate = Join-Path $shimDir 'node_modules/bun/bin/bun.exe'
	if (Test-Path -LiteralPath $bunCandidate) { $bunExe = $bunCandidate }
	elseif ($bunCommand.Source -like '*.exe') { $bunExe = $bunCommand.Source }
}
if (-not $bunExe) { $bunExe = 'bun' }

$entryArgs = @((Join-Path $PSScriptRoot 'monitor.ts'))
if ($Rounds -gt 0) { $entryArgs += @('--rounds', [string]$Rounds) }
if ($Workspace) { $entryArgs += @('--workspace', $Workspace) }
if ($Out) { $entryArgs += @('--out', $Out) }
if ($FailOn) { $entryArgs += @('--fail-on', $FailOn) }
if ($EvidenceKind) { $entryArgs += @('--evidence-kind', $EvidenceKind) }
if ($Json) { $entryArgs += '--json' }
if ($NoAppend) { $entryArgs += '--no-append' }

$ErrorActionPreference = 'Continue'
& $bunExe @entryArgs
$entryExit = $LASTEXITCODE
$ErrorActionPreference = $nativePreference
exit $entryExit
