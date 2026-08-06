[CmdletBinding()]
param(
	[ValidateSet("stable", "beta")]
	[string]$Channel = "__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$downloadBaseUrl = "__PRIME_AGENT_DOWNLOAD_BASE_URL__".TrimEnd("/")
$minimumNodeVersion = [Version]"22.8.0"
$tempDirectory = $null
$previousBootstrapTools = [Environment]::GetEnvironmentVariable("PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL", "Process")
$previousBootstrapKernel = [Environment]::GetEnvironmentVariable("PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL", "Process")
$previousInstallUv = [Environment]::GetEnvironmentVariable("PRIME_AGENT_INSTALL_UV", "Process")

function Get-RequiredCommand {
	param(
		[string]$Name,
		[string]$InstallMessage
	)

	$command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
	if (-not $command) {
		throw $InstallMessage
	}
	return $command
}

function Get-Sha256 {
	param([string]$Path)

	$stream = [IO.File]::OpenRead($Path)
	$sha256 = [Security.Cryptography.SHA256]::Create()
	try {
		return [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace("-", "").ToLowerInvariant()
	} finally {
		$sha256.Dispose()
		$stream.Dispose()
	}
}

function Get-WebText {
	param([string]$Uri)

	$response = Invoke-WebRequest -UseBasicParsing -Uri $Uri
	if ($response.Content -is [byte[]]) {
		return [Text.Encoding]::UTF8.GetString($response.Content)
	}
	return [string]$response.Content
}

function Get-BashPath {
	$candidates = @()
	foreach ($programFiles in @(
		[Environment]::GetEnvironmentVariable("ProgramFiles"),
		[Environment]::GetEnvironmentVariable("ProgramFiles(x86)"),
		[Environment]::GetEnvironmentVariable("LOCALAPPDATA")
	)) {
		if ($programFiles) {
			$relativePath = if ($programFiles -eq [Environment]::GetEnvironmentVariable("LOCALAPPDATA")) {
				"Programs\Git\bin\bash.exe"
			} else {
				"Git\bin\bash.exe"
			}
			$candidates += Join-Path $programFiles $relativePath
		}
	}
	foreach ($candidate in $candidates) {
		if (Test-Path -LiteralPath $candidate -PathType Leaf) {
			return $candidate
		}
	}
	return $null
}

try {
	if ($downloadBaseUrl.Contains("__PRIME_AGENT_")) {
		throw "This source template is not an installer. Use the published install.ps1 URL."
	}

	$node = Get-RequiredCommand "node.exe" "Node.js 22.8.0 or newer is required: https://nodejs.org/"
	$npm = Get-RequiredCommand "npm.cmd" "npm is required and normally ships with Node.js: https://nodejs.org/"
	if (-not (Get-BashPath)) {
		throw "Git Bash is required to run Prime Agent on Windows: https://git-scm.com/download/win"
	}

	$nodeVersionText = (& $node.Source --version | Out-String).Trim().TrimStart([char]"v")
	try {
		$nodeVersion = [Version]($nodeVersionText.Split("-")[0])
	} catch {
		throw "Could not parse Node.js version: $nodeVersionText"
	}
	if ($nodeVersion -lt $minimumNodeVersion) {
		throw "Node.js $minimumNodeVersion or newer is required; found $nodeVersion."
	}
	$nodeArchitecture = (& $node.Source -p "process.arch" | Out-String).Trim()
	if ($nodeArchitecture -ne "x64") {
		throw "Prime Agent native Windows support requires x64 Node.js; found $nodeArchitecture."
	}

	$version = (Get-WebText "$downloadBaseUrl/$Channel").Trim()
	if ($version.StartsWith("v", [StringComparison]::Ordinal)) {
		$version = $version.Substring(1)
	}
	$identifier = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
	if ($version -notmatch "^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-$identifier(?:\.$identifier)*)?$") {
		throw "Invalid Prime Agent version returned by the $Channel channel: $version"
	}

	$tempDirectory = Join-Path ([IO.Path]::GetTempPath()) "prime-agent-$([Guid]::NewGuid().ToString('N'))"
	New-Item -ItemType Directory -Path $tempDirectory | Out-Null
	$tarballName = "prime-agent-$version.tgz"
	$tarballPath = Join-Path $tempDirectory $tarballName
	$checksumsPath = Join-Path $tempDirectory "SHA256SUMS"
	$releaseUrl = "$downloadBaseUrl/releases/v$version"

	Write-Host "Downloading Prime Agent $version..."
	Invoke-WebRequest -UseBasicParsing -Uri "$releaseUrl/$tarballName" -OutFile $tarballPath
	Invoke-WebRequest -UseBasicParsing -Uri "$releaseUrl/SHA256SUMS" -OutFile $checksumsPath

	$checksumPattern = "^([0-9a-fA-F]{64})\s+\*?$([Regex]::Escape($tarballName))$"
	$checksumLine = Get-Content -LiteralPath $checksumsPath | Where-Object { $_ -match $checksumPattern } | Select-Object -First 1
	if (-not $checksumLine -or $checksumLine -notmatch $checksumPattern) {
		throw "Checksum for $tarballName was not found in SHA256SUMS."
	}
	$expectedChecksum = $Matches[1].ToLowerInvariant()
	$actualChecksum = Get-Sha256 $tarballPath
	if ($actualChecksum -ne $expectedChecksum) {
		throw "Checksum mismatch for $tarballName."
	}

	$env:PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL = "1"
	$env:PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL = "1"
	$env:PRIME_AGENT_INSTALL_UV = "1"
	& $npm.Source install -g --no-fund --no-audit --loglevel=error --progress=false $tarballPath
	if ($LASTEXITCODE -ne 0) {
		throw "npm install failed with exit code $LASTEXITCODE."
	}

	Write-Host "Prime Agent $version installed. Run: prime-agent"
} finally {
	[Environment]::SetEnvironmentVariable("PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL", $previousBootstrapTools, "Process")
	[Environment]::SetEnvironmentVariable("PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL", $previousBootstrapKernel, "Process")
	[Environment]::SetEnvironmentVariable("PRIME_AGENT_INSTALL_UV", $previousInstallUv, "Process")
	if ($tempDirectory) {
		try {
			Remove-Item -LiteralPath $tempDirectory -Recurse -Force
		} catch {
			Write-Warning "Could not remove temporary installer directory: $tempDirectory"
		}
	}
}
