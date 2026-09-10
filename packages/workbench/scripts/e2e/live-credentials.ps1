# Live-model credential loading (DPAPI) and default model / endpoint.
#
# Shared by run-live.ps1 and monitor.ps1. The key only ever lives in the current
# process environment: it is never written to disk, never printed, and never
# copied into a report. Default model is SenseAudio S2 Flash (wired 2026-09-10,
# see docs/report-2026-09-10-senseaudio-first-live.md).
#
# Callers own the try/finally that restores $env:E2E_LLM_*; this file only loads.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 without a
# BOM as ANSI, so non-ASCII here turns into mojibake and can break parsing.

function Import-LiveModelCredentials {
	param(
		[string]$DefaultModel = 'senseaudio-s2-flash',
		[string]$DefaultBaseUrl = 'https://api.senseaudio.cn/v1'
	)

	if (-not $env:E2E_LLM_KEY) {
		$credentialPath = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'HelmorWorkbench/credentials/openrouter.dpapi'
		if (-not (Test-Path -LiteralPath $credentialPath)) {
			throw "Live-model credential not found: $credentialPath"
		}
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
	if (-not $env:E2E_LLM_MODEL) { $env:E2E_LLM_MODEL = $DefaultModel }
	if (-not $env:E2E_LLM_BASE_URL) { $env:E2E_LLM_BASE_URL = $DefaultBaseUrl }
}
