param(
	[switch]$CheckOnly,
	[string]$DevelopmentWorkspace,
	[string]$MoyuSoakLabel,
	[int]$MoyuSoakRounds = 0
)

# Thin wrapper around live-entry.ts. Credentials are read inside that entry
# (env first, else DPAPI via bun:ffi), so this script no longer decrypts anything
# itself and no longer needs to set or restore E2E_LLM_* in the parent session.
#
# NOTE: this wrapper only helps on hosts where PowerShell *can* start a native
# process. Measured 2026-09-12 on this machine: the embedded PowerShell tool does
# not start native processes at all (the sandbox switch makes no difference and
# $LASTEXITCODE is never set), so from that host use live-entry.ts straight from a
# shell instead. This is why the entry point is host-agnostic.

$ErrorActionPreference = 'Stop'

# Prefer a real bun executable over the npm shim (bun.ps1), whose behaviour depends
# on the host it is invoked from.
$bunExe = $null
$bunCommand = Get-Command bun -ErrorAction SilentlyContinue
if ($bunCommand) {
	$shimDir = Split-Path $bunCommand.Source -Parent
	$bunCandidate = Join-Path $shimDir 'node_modules/bun/bin/bun.exe'
	if (Test-Path -LiteralPath $bunCandidate) { $bunExe = $bunCandidate }
	elseif ($bunCommand.Source -like '*.exe') { $bunExe = $bunCommand.Source }
}
if (-not $bunExe) { $bunExe = 'bun' }

$entry = Join-Path $PSScriptRoot 'live-entry.ts'
if ($CheckOnly) {
	& $bunExe $entry check
} elseif ($MoyuSoakLabel) {
	$entryArgs = @($entry, 'moyu-soak', $MoyuSoakLabel)
	if ($MoyuSoakRounds -gt 0) { $entryArgs += [string]$MoyuSoakRounds }
	& $bunExe @entryArgs
} elseif ($DevelopmentWorkspace) {
	$workspacePath = (Resolve-Path -LiteralPath $DevelopmentWorkspace).Path
	& $bunExe $entry development $workspacePath
} else {
	& $bunExe $entry scenario
}
exit $LASTEXITCODE
