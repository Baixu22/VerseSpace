<#
.SYNOPSIS
  Browser E2E: real Chromium + real Vite frontend + a real `workbench ui` backend.

.DESCRIPTION
  TF-0255 (acceptance item 2). The `workbench-ui-e2e` CI job is a thin wrapper
  around this script, so the job's sequence is something that can be — and has
  been — executed on this host. It:

    1. creates an isolated workspace and runs `workbench init` in it;
    2. (unless -SkipConfigSandbox) configures it for the opt-in lane:
       provider=openai-responses, effort=high;
    3. starts the backend on -ApiPort and Vite on -UiPort — both movable, so a
       run does not collide with whatever the developer already has running;
    4. seeds five conversations and current/stale/unknown artifact reviews;
       missing preconditions are reported as failures **with a reason** rather
       than silent skips (TF-0255's third acceptance item);
    5. runs `playwright test`;
    6. tears everything down: the process tree, then the temp workspace.

  Exit code is Playwright's. No model credentials are needed: the opt-in test
  only checks that the settings API persists the choice.

.EXAMPLE
  pwsh -NoProfile -File scripts/win/e2e-browser.ps1
  pwsh -NoProfile -File scripts/win/e2e-browser.ps1 -ApiPort 7800 -UiPort 5288
  pwsh -NoProfile -File scripts/win/e2e-browser.ps1 -InstallBrowsers -KeepWorkspace
#>
[CmdletBinding()]
param(
	[int]$ApiPort = 7700,
	[int]$UiPort = 5188,
	[switch]$SkipConfigSandbox,
	[switch]$InstallBrowsers,
	[switch]$KeepWorkspace
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

# Resolve bun.exe explicitly. `Get-Command bun` returns npm's `bun.ps1` shim
# first on this host, and `Start-Process` cannot run a .ps1 — it fails with
# "%1 不是有效的 Win32 应用程序". BUN_BIN is what the CI runner sets.
$bunCandidates = @()
if ($env:BUN_BIN) { $bunCandidates += (Join-Path $env:BUN_BIN 'bun.exe') }
if ($env:APPDATA) { $bunCandidates += (Join-Path $env:APPDATA 'npm\node_modules\bun\bin\bun.exe') }
$bunOnPath = (Get-Command bun.exe -ErrorAction SilentlyContinue).Source
if ($bunOnPath) { $bunCandidates += $bunOnPath }
$bun = $bunCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $bun) {
	throw 'bun.exe not found. Start-Process cannot run npm''s bun.ps1 shim; set BUN_BIN or put bun.exe on PATH.'
}

$ws = Join-Path ([System.IO.Path]::GetTempPath()) ("workbench-e2e-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$uiDir = Join-Path $repo 'apps\workbench-ui'
$apiProc = $null
$uiProc = $null
$exitCode = 1

function Wait-Http {
	param([string]$Url, [int]$Seconds = 90)
	$deadline = (Get-Date).AddSeconds($Seconds)
	while ((Get-Date) -lt $deadline) {
		try {
			Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3 | Out-Null
			return $true
		} catch {
			# Any HTTP answer (even 401) means the socket is up; only a refused
			# connection means "not yet".
			if ($_.Exception.Response) { return $true }
		}
		Start-Sleep -Milliseconds 500
	}
	return $false
}

try {
	New-Item -ItemType Directory -Force -Path $ws | Out-Null
	Write-Host "[e2e] isolated workspace: $ws"

	Push-Location $ws
	try {
		& $bun "$repo\packages\workbench\src\index.ts" init | Out-Null
		if ($LASTEXITCODE -ne 0) { throw "workbench init exited $LASTEXITCODE" }
	} finally { Pop-Location }

	if (-not $SkipConfigSandbox) {
		$yaml = Join-Path $ws '.workbench\workbench.yaml'
		(Get-Content $yaml -Raw) -replace 'provider: claude', "provider: openai-responses`n  effort: high" |
			Set-Content $yaml -NoNewline
		Write-Host '[e2e] opt-in lane configured: provider=openai-responses, effort=high'
	}

	if ($InstallBrowsers) {
		Write-Host '[e2e] playwright install chromium'
		Push-Location $uiDir
		try { & $bun x playwright install chromium } finally { Pop-Location }
	}

	# Child processes inherit this environment; set it before starting them.
	$env:NO_PROXY = '127.0.0.1,localhost,::1'
	Remove-Item Env:HTTP_PROXY, Env:HTTPS_PROXY, Env:ALL_PROXY -ErrorAction SilentlyContinue

	Write-Host "[e2e] backend on :$ApiPort"
	$apiProc = Start-Process -FilePath $bun `
		-ArgumentList @("$repo\packages\workbench\src\index.ts", 'ui', '--port', "$ApiPort", '--no-open') `
		-WorkingDirectory $ws -PassThru -WindowStyle Hidden `
		-RedirectStandardOutput (Join-Path $ws 'api.out.log') -RedirectStandardError (Join-Path $ws 'api.err.log')

	$env:WORKBENCH_UI_DEV_PORT = "$UiPort"
	$env:WORKBENCH_API_TARGET = "http://127.0.0.1:$ApiPort"
	Write-Host "[e2e] vite on :$UiPort (proxying /api to :$ApiPort)"
	$uiProc = Start-Process -FilePath $bun -ArgumentList @('run', 'dev:ui') `
		-WorkingDirectory $repo -PassThru -WindowStyle Hidden `
		-RedirectStandardOutput (Join-Path $ws 'ui.out.log') -RedirectStandardError (Join-Path $ws 'ui.err.log')

	if (-not (Wait-Http -Url "http://127.0.0.1:$ApiPort/api/bootstrap" -Seconds 90)) {
		throw "backend did not answer on :$ApiPort — see $ws\api.err.log"
	}
	if (-not (Wait-Http -Url "http://127.0.0.1:$UiPort/" -Seconds 120)) {
		throw "vite did not answer on :$UiPort — see $ws\ui.err.log"
	}

	# Two conversations: the spec's preconditions. Seeding them here is what keeps
	# "缺前置数据" a real failure instead of an invisible skip.
	$boot = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/api/bootstrap"
	$headers = @{ 'content-type' = 'application/json'; 'x-workbench-token' = $boot.token }
	$titles = @(
		'e2e conversation 1',
		'e2e conversation 2',
		'e2e artifact current',
		'e2e artifact stale',
		'e2e artifact unknown'
	)
	$threads = foreach ($title in $titles) {
		$body = @{ title = $title } | ConvertTo-Json -Compress
		Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/api/chat/threads" -Method Post -Headers $headers -Body $body
	}
	$artifactSeed = & $bun "$repo\packages\workbench\scripts\e2e\seed-artifact-reviews.ts" `
		--workspace $ws `
		--current $threads[2].id `
		--stale $threads[3].id `
		--unknown $threads[4].id
	if ($LASTEXITCODE -ne 0) { throw "artifact review seed exited $LASTEXITCODE" }
	Write-Host "[e2e] seeded 5 conversations and artifact states: $artifactSeed"

	$env:WORKBENCH_E2E_URL = "http://127.0.0.1:$UiPort"
	if ($SkipConfigSandbox) {
		Remove-Item Env:WORKBENCH_E2E_CONFIG_SANDBOX -ErrorAction SilentlyContinue
	} else {
		$env:WORKBENCH_E2E_CONFIG_SANDBOX = '1'
	}

	Push-Location $uiDir
	try {
		& $bun run test:e2e
		$exitCode = $LASTEXITCODE
	} finally { Pop-Location }

	Write-Host "[e2e] playwright exited $exitCode"
} catch {
	Write-Host "[e2e] FAILED: $($_.Exception.Message)"
	$exitCode = 1
} finally {
	foreach ($proc in @($uiProc, $apiProc)) {
		if ($proc -and -not $proc.HasExited) {
			# /T so the whole tree goes: bun → vite → esbuild, bun → workbench ui.
			& taskkill /PID $proc.Id /T /F 2>&1 | Out-Null
		}
	}
	if ($KeepWorkspace) {
		Write-Host "[e2e] workspace kept: $ws"
	} else {
		Remove-Item -Recurse -Force $ws -ErrorAction SilentlyContinue
	}
}

exit $exitCode
