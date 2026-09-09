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
	if (-not $env:E2E_LLM_KEY) {
		$credentialPath = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'HelmorWorkbench/credentials/openrouter.dpapi'
		$encryptedLiveKey = (Get-Content -Raw -LiteralPath $credentialPath).Trim()
		try { $liveSecureKey = ConvertTo-SecureString $encryptedLiveKey }
		catch { throw 'Cannot decrypt the local live-model credential for this Windows user.' }
		$liveKeyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($liveSecureKey)
		try {
			$env:E2E_LLM_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($liveKeyPointer)
		} finally {
			[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($liveKeyPointer)
			$liveSecureKey.Dispose()
		}
	}
	if (-not $env:E2E_LLM_MODEL) { $env:E2E_LLM_MODEL = 'senseaudio-s2-flash' }
	if (-not $env:E2E_LLM_BASE_URL) { $env:E2E_LLM_BASE_URL = 'https://api.senseaudio.cn/v1' }
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
