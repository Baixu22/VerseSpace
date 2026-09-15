#Requires -Version 5.1
param([string]$ParentDirectory = [IO.Path]::GetTempPath())

$ErrorActionPreference = 'Stop'
$gitCheckParent = (Resolve-Path -LiteralPath $ParentDirectory).ProviderPath
$gitCheckRoot = Join-Path $gitCheckParent ('helmor-git-check-' + [guid]::NewGuid().ToString('N'))
$gitCheckRepo = Join-Path $gitCheckRoot 'repo'
$gitCheckPath = (Get-Command git.exe -CommandType Application | Select-Object -First 1).Source
$gitCheckReport = [ordered]@{ fixture = $gitCheckRoot; git = $gitCheckPath; commands = @(); passed = $false }
$gitCheckPreviousGlobal = $env:GIT_CONFIG_GLOBAL
$gitCheckPreviousSystem = $env:GIT_CONFIG_SYSTEM
$gitCheckExit = 1

function Invoke-FixtureGit([string[]]$Arguments) {
	$gitCheckOutput = & $gitCheckPath -c core.excludesFile=NUL -c core.attributesFile=NUL -C $gitCheckRepo @Arguments 2>&1 | Out-String
	$gitCheckCode = $LASTEXITCODE
	$gitCheckReport.commands += @{ arguments = $Arguments; exitCode = $gitCheckCode; output = $gitCheckOutput.Trim() }
	if ($gitCheckCode -ne 0) { throw "Fixture Git failed: $($Arguments -join ' ')" }
	return $gitCheckOutput.Trim()
}

try {
	[IO.Directory]::CreateDirectory($gitCheckRoot) | Out-Null
	$gitCheckResolved = (Resolve-Path -LiteralPath $gitCheckRoot).ProviderPath
	if ([IO.Path]::GetDirectoryName($gitCheckResolved).TrimEnd('\') -ne $gitCheckParent.TrimEnd('\') -or
		((Get-Item -LiteralPath $gitCheckRoot).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
		throw 'The diagnostic directory is outside its requested parent or is a link.'
	}
	if (-not ('Helmor.WindowsGitCheck' -as [type])) {
		Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace Helmor {
    public static class WindowsGitCheck {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool RemoveDirectoryW(string path);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr GetModuleHandleW(string name);
    }
}
'@
	}
	$gitCheckReport.tsbxLoaded = [Helmor.WindowsGitCheck]::GetModuleHandleW('tsbx.dll') -ne [IntPtr]::Zero
	$gitCheckNonempty = Join-Path $gitCheckRoot 'nonempty'
	[IO.Directory]::CreateDirectory($gitCheckNonempty) | Out-Null
	$gitCheckSentinel = Join-Path $gitCheckNonempty 'keep.txt'
	[IO.File]::WriteAllText($gitCheckSentinel, 'must survive')
	$gitCheckRemoved = [Helmor.WindowsGitCheck]::RemoveDirectoryW($gitCheckNonempty)
	$gitCheckError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
	$gitCheckReport.nonemptyDirectory = @{
		removeReturned = $gitCheckRemoved
		win32Error = $gitCheckError
		keepExists = [IO.File]::Exists($gitCheckSentinel)
	}

	# All operations below affect only the new fixture. Keep it for inspection.
	$env:GIT_CONFIG_GLOBAL = 'NUL'
	$env:GIT_CONFIG_SYSTEM = 'NUL'
	[IO.Directory]::CreateDirectory((Join-Path $gitCheckRepo 'src')) | Out-Null
	[IO.File]::WriteAllText((Join-Path $gitCheckRepo 'src/keep.txt'), 'must survive')
	[IO.File]::WriteAllText((Join-Path $gitCheckRepo 'src/delete.txt'), 'delete only this file')
	$null = Invoke-FixtureGit @('init', '-q', '--initial-branch=main', '--ref-format=files')
	$null = Invoke-FixtureGit @('add', '.')
	$null = Invoke-FixtureGit @('-c', 'user.name=Git filesystem check', '-c', 'user.email=fixture@example.invalid',
		'-c', 'core.hooksPath=NUL', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture')
	$gitCheckHead = Invoke-FixtureGit @('rev-parse', 'HEAD')
	$null = Invoke-FixtureGit @('branch', 'ws/probe')
	$null = Invoke-FixtureGit @('update-ref', 'refs/remotes/origin/main', 'HEAD')
	$null = Invoke-FixtureGit @('rm', '--', 'src/delete.txt')
	$gitCheckRefs = @('refs/heads/ws/probe', 'refs/remotes/origin/main')
	$gitCheckRefResults = foreach ($gitCheckRef in $gitCheckRefs) {
		$gitCheckRefPath = Join-Path $gitCheckRepo ('.git/' + $gitCheckRef)
		@{ ref = $gitCheckRef; correct = [IO.File]::Exists($gitCheckRefPath) -and
			[IO.File]::ReadAllText($gitCheckRefPath).Trim() -eq $gitCheckHead }
	}
	$gitCheckReport.gitState = @{
		keepExists = [IO.File]::Exists((Join-Path $gitCheckRepo 'src/keep.txt'))
		targetExists = [IO.File]::Exists((Join-Path $gitCheckRepo 'src/delete.txt'))
		refs = @($gitCheckRefResults)
	}
	$gitCheckReport.passed = -not $gitCheckRemoved -and $gitCheckError -eq 145 -and
		$gitCheckReport.nonemptyDirectory.keepExists -and $gitCheckReport.gitState.keepExists -and
		-not $gitCheckReport.gitState.targetExists -and @($gitCheckRefResults | Where-Object { -not $_.correct }).Count -eq 0
	if ($gitCheckReport.passed) { $gitCheckExit = 0 }
} catch {
	$gitCheckReport.error = $_.Exception.Message
} finally {
	$env:GIT_CONFIG_GLOBAL = $gitCheckPreviousGlobal
	$env:GIT_CONFIG_SYSTEM = $gitCheckPreviousSystem
	$gitCheckJson = $gitCheckReport | ConvertTo-Json -Depth 6
	if (Test-Path -LiteralPath $gitCheckRoot) {
		[IO.File]::WriteAllText((Join-Path $gitCheckRoot 'result.json'), $gitCheckJson)
	}
	$gitCheckJson
}
exit $gitCheckExit
