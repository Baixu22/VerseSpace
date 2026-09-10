param(
	[switch]$CheckOnly,
	[string]$DevelopmentWorkspace
)

$ErrorActionPreference = 'Stop'
$previousLiveKey = $env:E2E_LLM_KEY
$previousLiveModel = $env:E2E_LLM_MODEL
$previousLiveBase = $env:E2E_LLM_BASE_URL
$liveExitCode = 0
try {
	. (Join-Path $PSScriptRoot 'live-credentials.ps1')
	Import-LiveModelCredentials
	if ($CheckOnly) {
		Write-Output 'Live model credentials loaded; no secret output or workspace changes.'
	} elseif ($DevelopmentWorkspace) {
		$liveWorkspacePath = (Resolve-Path -LiteralPath $DevelopmentWorkspace).Path
		& bun (Join-Path $PSScriptRoot 'live-development.ts') $liveWorkspacePath
		$liveExitCode = $LASTEXITCODE
		if ($liveExitCode -eq 0) {
			& bun (Join-Path $PSScriptRoot 'live-fork.ts') $liveWorkspacePath
			$liveExitCode = $LASTEXITCODE
		}
	} else {
		& bun (Join-Path $PSScriptRoot 'live-run.ts')
		$liveExitCode = $LASTEXITCODE
	}
} finally {
	$env:E2E_LLM_KEY = $previousLiveKey
	$env:E2E_LLM_MODEL = $previousLiveModel
	$env:E2E_LLM_BASE_URL = $previousLiveBase
}
exit $liveExitCode
