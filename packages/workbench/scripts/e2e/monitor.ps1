# Data monitoring + real-sample accumulation in one entry point.
#
# Why both in one script: a sample only means something inside a live tenant, and
# a tenant only grows judgeable numbers while it keeps sampling. Waiting a month
# for daily use defers every problem by a month; here each batch ends with a
# diff report, so a dropped threshold, a counter that went backwards, or a
# report that disagrees with the ledger shows up the same day.
#
# Usage:
#   ./monitor.ps1                       # monitor only (read-only, no credential needed)
#   ./monitor.ps1 -Rounds 3             # 3 more live rounds, then the monitor report
#   ./monitor.ps1 -Rounds 3 -Out ../../../docs/fit-monitor.md -FailOn warn
#
# Credentials: default model SenseAudio S2 Flash, key loaded from
# %LOCALAPPDATA%/HelmorWorkbench/credentials/openrouter.dpapi via
# live-credentials.ps1. The key is never written to disk or printed.
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
# Native commands are exempt from that preference: under 5.1 a native process
# writing to stderr turns into a terminating NativeCommandError, so any caller
# that merges streams ("./monitor.ps1 -Rounds 3 2>&1 | ...") would kill the batch
# on the first progress line and never run the monitor. Both bun calls below run
# with the preference relaxed and check $LASTEXITCODE explicitly instead.
$nativePreference = $ErrorActionPreference
$ws = if ($Workspace) { (Resolve-Path -LiteralPath $Workspace).Path } else { Join-Path $env:TEMP 'workbench-e2e-live-tenant' }
$previousLiveKey = $env:E2E_LLM_KEY
$previousLiveModel = $env:E2E_LLM_MODEL
$previousLiveBase = $env:E2E_LLM_BASE_URL
$exitCode = 0
try {
	if ($Rounds -gt 0) {
		. (Join-Path $PSScriptRoot 'live-credentials.ps1')
		Import-LiveModelCredentials
		$historyPath = Join-Path $ws 'runs/history.jsonl'
		$done = 0
		if (Test-Path -LiteralPath $historyPath) {
			$done = @(Get-Content -LiteralPath $historyPath | Where-Object { $_.Trim() }).Count
		}
		Write-Output ("[monitor] model {0} - endpoint {1} - tenant {2} - appending {3} round(s) from index {4}" -f $env:E2E_LLM_MODEL, $env:E2E_LLM_BASE_URL, $ws, $Rounds, ($done + 1))
		$runScript = Join-Path $PSScriptRoot 'run.ts'
		$ErrorActionPreference = 'Continue'
		& bun $runScript --live --rounds $Rounds --start-round ($done + 1) --workspace $ws
		$runExit = $LASTEXITCODE
		$ErrorActionPreference = $nativePreference
		if ($runExit -ne 0) {
			$runsDir = Join-Path $ws 'runs'
			Write-Output ("[monitor] the sampling batch had failing rounds; tenant kept at {0}" -f $runsDir)
			$exitCode = 1
		}
	}

	$monitorScript = Join-Path (Split-Path -Parent $PSScriptRoot) 'fit-monitor.ts'
	$monitorArgs = @($monitorScript, '--workspace', $ws, '--evidence-kind', $EvidenceKind, '--fail-on', $FailOn)
	if ($Out) { $monitorArgs += @('--out', $Out) }
	if ($Json) { $monitorArgs += '--json' }
	if ($NoAppend) { $monitorArgs += '--no-append' }
	$ErrorActionPreference = 'Continue'
	& bun @monitorArgs
	$monitorExit = $LASTEXITCODE
	$ErrorActionPreference = $nativePreference
	if ($monitorExit -ne 0) { $exitCode = $monitorExit }
} finally {
	$env:E2E_LLM_KEY = $previousLiveKey
	$env:E2E_LLM_MODEL = $previousLiveModel
	$env:E2E_LLM_BASE_URL = $previousLiveBase
}
exit $exitCode
