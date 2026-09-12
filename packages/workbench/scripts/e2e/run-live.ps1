param(
	[switch]$CheckOnly,
	[string]$DevelopmentWorkspace,
	[string]$MoyuSoakLabel,
	[int]$MoyuSoakRounds = 0
)

$ErrorActionPreference = 'Stop'
$previousLiveKey = $env:E2E_LLM_KEY
$previousLiveModel = $env:E2E_LLM_MODEL
$previousLiveBase = $env:E2E_LLM_BASE_URL
$liveExitCode = 0
try {
	. (Join-Path $PSScriptRoot 'live-credentials.ps1')
	Import-LiveModelCredentials
	# Resolve a real bun executable. The npm shim (bun.ps1) silently no-ops in a
	# non-interactive PowerShell session: it prints nothing and returns exit 0, so
	# the run looks successful while doing absolutely nothing. Measured 2026-09-12.
	$bunExe = $null
	$bunCommand = Get-Command bun -ErrorAction SilentlyContinue
	if ($bunCommand) {
		$shimDir = Split-Path $bunCommand.Source -Parent
		$bunCandidate = Join-Path $shimDir 'node_modules/bun/bin/bun.exe'
		if (Test-Path -LiteralPath $bunCandidate) { $bunExe = $bunCandidate }
		elseif ($bunCommand.Source -like '*.exe') { $bunExe = $bunCommand.Source }
	}
	if (-not $bunExe) { $bunExe = 'bun' }
	if ($CheckOnly) {
		Write-Output 'Live model credentials loaded; no secret output or workspace changes.'
	} elseif ($DevelopmentWorkspace) {
		$liveWorkspacePath = (Resolve-Path -LiteralPath $DevelopmentWorkspace).Path
		& $bunExe (Join-Path $PSScriptRoot 'live-development.ts') $liveWorkspacePath
		$liveExitCode = $LASTEXITCODE
		if ($liveExitCode -eq 0) {
			& $bunExe (Join-Path $PSScriptRoot 'live-fork.ts') $liveWorkspacePath
			$liveExitCode = $LASTEXITCODE
		}
	} elseif ($MoyuSoakLabel) {
		# Long-term accumulation on the real moyu repo (TF-0163): repeated rounds
		# land in one persistent site so moat A grows on a single blackboard.
		$env:E2E_MOYU_LABEL = $MoyuSoakLabel
		if ($MoyuSoakRounds -gt 0) { $env:E2E_MOYU_ROUNDS = [string]$MoyuSoakRounds }
		& $bunExe (Join-Path $PSScriptRoot 'live-moyu-soak.ts')
		$liveExitCode = $LASTEXITCODE
	} else {
		& $bunExe (Join-Path $PSScriptRoot 'live-run.ts')
		$liveExitCode = $LASTEXITCODE
	}
} finally {
	$env:E2E_LLM_KEY = $previousLiveKey
	$env:E2E_LLM_MODEL = $previousLiveModel
	$env:E2E_LLM_BASE_URL = $previousLiveBase
}
exit $liveExitCode
