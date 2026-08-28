[CmdletBinding()]
param(
  [string[]]$AllowedRoot,
  [string]$PublicBaseUrl,
  [int]$Port,
  [switch]$ResetToken,
  [switch]$ForceInstall,
  [switch]$SkipBuild,
  [switch]$ShowOwnerToken
)

$ErrorActionPreference = "Stop"

function Require-Command {
  param(
    [string]$Name,
    [string]$InstallHint
  )

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name was not found. $InstallHint"
  }
}

function Invoke-Npm {
  param([string[]]$Arguments)

  # Windows PowerShell 可能优先解析 npm.ps1；显式调用 npm.cmd，确保数组参数不会被 shim 错误拆解。
  & npm.cmd @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "npm $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
  }
}

function Get-StringValues {
  param([object]$Value)

  return @(
    $Value |
      ForEach-Object { [string]$_ } |
      ForEach-Object { $_.Trim() } |
      Where-Object { $_ }
  )
}

function Resolve-AllowedRoots {
  param([string[]]$Roots)

  $resolvedRoots = New-Object System.Collections.Generic.List[string]
  $seen = @{}

  foreach ($rootGroup in $Roots) {
    foreach ($candidate in ($rootGroup -split ",")) {
      $trimmed = $candidate.Trim()
      if (-not $trimmed) {
        continue
      }
      if (-not (Test-Path -LiteralPath $trimmed)) {
        throw "Allowed root does not exist: $trimmed"
      }

      $item = Get-Item -LiteralPath $trimmed
      if (-not $item.PSIsContainer) {
        throw "Allowed root must be a directory: $trimmed"
      }

      $resolved = $item.FullName
      $key = $resolved.ToLowerInvariant()
      if (-not $seen.ContainsKey($key)) {
        $seen[$key] = $true
        $resolvedRoots.Add($resolved)
      }
    }
  }

  if ($resolvedRoots.Count -eq 0) {
    throw "Provide at least one existing directory through -AllowedRoot."
  }

  return $resolvedRoots.ToArray()
}

function Resolve-Port {
  param(
    [bool]$IsSpecified,
    [int]$RequestedPort,
    [object]$ExistingPort
  )

  $candidate = if ($IsSpecified) { $RequestedPort } elseif ($null -ne $ExistingPort) { [int]$ExistingPort } else { 7676 }
  if ($candidate -lt 1 -or $candidate -gt 65535) {
    throw "Port must be an integer between 1 and 65535."
  }

  return $candidate
}

function Normalize-PublicBaseUrl {
  param([AllowNull()][string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $null
  }

  $trimmed = $Value.Trim().TrimEnd("/")
  try {
    $uri = [System.Uri]$trimmed
  } catch {
    throw "PublicBaseUrl must be an absolute http or https URL."
  }

  if (-not $uri.IsAbsoluteUri -or $uri.Scheme -notin @("http", "https")) {
    throw "PublicBaseUrl must be an absolute http or https URL."
  }
  if ($uri.Query -or $uri.Fragment) {
    throw "PublicBaseUrl must not include a query string or fragment."
  }
  if ($uri.AbsolutePath -match "/mcp/?$") {
    throw "PublicBaseUrl must be the base URL without /mcp."
  }

  return $trimmed
}

function Get-GitBashPath {
  $bashCommand = Get-Command "bash" -ErrorAction SilentlyContinue
  if ($bashCommand) {
    return $bashCommand.Source
  }

  $candidates = @(
    (Join-Path $env:ProgramFiles "Git\bin\bash.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Git\bin\bash.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Git\bin\bash.exe")
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

  if ($candidates.Count -gt 0) {
    return $candidates[0]
  }

  throw "Bash was not found. Install Git for Windows with Git Bash enabled, or install WSL."
}

function Invoke-DesktopConfig {
  param(
    [string]$Command,
    [AllowNull()][string]$Payload
  )

  $tsxCommand = Join-Path $projectRoot "node_modules\.bin\tsx.cmd"
  if (-not (Test-Path -LiteralPath $tsxCommand)) {
    throw "tsx was not installed correctly: $tsxCommand"
  }

  $previousPayload = $env:DEVSPACE_DESKTOP_SETUP_CONFIG
  try {
    if ($null -eq $Payload) {
      Remove-Item Env:DEVSPACE_DESKTOP_SETUP_CONFIG -ErrorAction SilentlyContinue
    } else {
      $env:DEVSPACE_DESKTOP_SETUP_CONFIG = $Payload
    }

    $output = (& $tsxCommand "scripts/desktop-config.ts" $Command | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
      throw "Desktop config helper failed with exit code $LASTEXITCODE."
    }
    if ([string]::IsNullOrWhiteSpace($output)) {
      throw "Desktop config helper returned no result."
    }
    return $output | ConvertFrom-Json
  } finally {
    if ($null -eq $previousPayload) {
      Remove-Item Env:DEVSPACE_DESKTOP_SETUP_CONFIG -ErrorAction SilentlyContinue
    } else {
      $env:DEVSPACE_DESKTOP_SETUP_CONFIG = $previousPayload
    }
  }
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $projectRoot

Write-Host ""
Write-Host "DevSpace one-click setup" -ForegroundColor Green
Write-Host "Project: $projectRoot"
Write-Host ""

Require-Command "node" "Install Node.js 22 LTS first."
Require-Command "npm" "Install npm with Node.js first."
Require-Command "git" "Install Git for Windows first."

$nodeVersionText = (& node --version).Trim()
try {
  $nodeVersion = [System.Version]$nodeVersionText.TrimStart("v")
} catch {
  throw "Unable to parse Node.js version: $nodeVersionText"
}
if ($nodeVersion -lt [System.Version]"22.19.0" -or $nodeVersion -ge [System.Version]"27.0.0") {
  throw "DevSpace requires Node.js >=22.19 and <27. Current version: $nodeVersionText"
}

$gitBashPath = Get-GitBashPath
$npmVersionText = (& npm.cmd --version).Trim()
$gitVersionText = (& git --version).Trim()
Write-Host "Node: $nodeVersionText"
Write-Host "npm:  $npmVersionText"
Write-Host "Git:  $gitVersionText"
Write-Host "Bash: $gitBashPath"
Write-Host ""

$nodeModulesPath = Join-Path $projectRoot "node_modules"
$electronPackagePath = Join-Path $nodeModulesPath "electron\package.json"
$electronBuilderPackagePath = Join-Path $nodeModulesPath "electron-builder\package.json"
$jsoncParserPackagePath = Join-Path $nodeModulesPath "jsonc-parser\package.json"
$desktopDependenciesReady =
  (Test-Path -LiteralPath $electronPackagePath) -and
  (Test-Path -LiteralPath $electronBuilderPackagePath) -and
  (Test-Path -LiteralPath $jsoncParserPackagePath)
$dependenciesNeedInstall = $ForceInstall -or -not (Test-Path -LiteralPath $nodeModulesPath) -or -not $desktopDependenciesReady
$packageLockPath = Join-Path $projectRoot "package-lock.json"
$packageLockExists = Test-Path -LiteralPath $packageLockPath

if ($packageLockExists) {
  # 官方 main 与 Desktop 层都会持续新增依赖。每次 setup 先同步 lock，保证复制升级后 npm ci 可重复执行。
  Write-Host "Synchronizing package-lock.json with current dependencies..." -ForegroundColor Cyan
  Invoke-Npm -Arguments @("install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund")
}

if ($dependenciesNeedInstall) {
  if ($packageLockExists) {
    Write-Host "Installing dependencies from synchronized package-lock.json..." -ForegroundColor Cyan
    Invoke-Npm -Arguments @("ci", "--include=dev")
  } else {
    Write-Host "Installing dependencies..." -ForegroundColor Cyan
    Invoke-Npm -Arguments @("install", "--include=dev")
  }
} else {
  Write-Host "Dependencies already exist. Use -ForceInstall to reinstall them." -ForegroundColor DarkGray
}

# 读取配置时复用官方迁移逻辑；若仍是 v1.0 的 config.json，会在这里安全迁移为 versioned config.jsonc。
$existingState = Invoke-DesktopConfig -Command "read" -Payload $null
$defaultAllowedRoot = Split-Path -Parent $projectRoot
if ($PSBoundParameters.ContainsKey("AllowedRoot")) {
  $resolvedAllowedRoots = Resolve-AllowedRoots -Roots $AllowedRoot
} elseif ($existingState.allowedRoots) {
  try {
    $resolvedAllowedRoots = Resolve-AllowedRoots -Roots (Get-StringValues $existingState.allowedRoots)
  } catch {
    Write-Warning "Existing allowedRoots cannot be used. Falling back to $defaultAllowedRoot."
    $resolvedAllowedRoots = Resolve-AllowedRoots -Roots @($defaultAllowedRoot)
  }
} else {
  $resolvedAllowedRoots = Resolve-AllowedRoots -Roots @($defaultAllowedRoot)
}

$resolvedPort = Resolve-Port `
  -IsSpecified ($PSBoundParameters.ContainsKey("Port")) `
  -RequestedPort $Port `
  -ExistingPort $existingState.port

$existingPublicBaseUrl = if ($null -ne $existingState.publicBaseUrl) { [string]$existingState.publicBaseUrl } else { $null }
$resolvedPublicBaseUrl = if ($PSBoundParameters.ContainsKey("PublicBaseUrl")) {
  Normalize-PublicBaseUrl -Value $PublicBaseUrl
} else {
  Normalize-PublicBaseUrl -Value $existingPublicBaseUrl
}

$payload = [ordered]@{
  allowedRoots = @($resolvedAllowedRoots)
  port = $resolvedPort
  publicBaseUrl = $resolvedPublicBaseUrl
  resetToken = [bool]$ResetToken
} | ConvertTo-Json -Depth 5 -Compress
$appliedState = Invoke-DesktopConfig -Command "apply" -Payload $payload

if (-not $SkipBuild) {
  Write-Host "Building DevSpace..." -ForegroundColor Cyan
  Invoke-Npm -Arguments @("run", "build")
}

Write-Host ""
Write-Host "Verifying DevSpace configuration..." -ForegroundColor Cyan
& npx.cmd --no-install tsx src/cli.ts doctor
if ($LASTEXITCODE -ne 0) {
  throw "DevSpace diagnostic failed with exit code $LASTEXITCODE."
}

Write-Host ""
Write-Host "DevSpace configured successfully." -ForegroundColor Green
Write-Host "Config: $($appliedState.configPath)"
Write-Host "Auth:   $($appliedState.authPath)"
Write-Host "Allowed roots: $($resolvedAllowedRoots -join ', ')"
Write-Host "Local MCP URL: http://127.0.0.1:$resolvedPort/mcp"

# 没有公网地址时仍允许本机使用，但远程 ChatGPT 连接前必须补充 HTTPS 隧道地址。
if ($resolvedPublicBaseUrl) {
  Write-Host "Public MCP URL: $resolvedPublicBaseUrl/mcp"
} else {
  Write-Warning "No public base URL is configured. Set -PublicBaseUrl after creating an HTTPS tunnel for remote MCP clients."
}

if ($ShowOwnerToken) {
  Write-Host "Owner password: $($appliedState.ownerToken)" -ForegroundColor Yellow
} else {
  Write-Host "Owner password was preserved or created in auth.json. Use -ShowOwnerToken only when you need to view it." -ForegroundColor DarkGray
}
if ($ResetToken) {
  Write-Warning "Owner password was rotated and issued OAuth access/refresh tokens were revoked. Restart any externally managed DevSpace service."
}

Write-Host ""
Write-Host "Start development mode with: npm run dev" -ForegroundColor Yellow
