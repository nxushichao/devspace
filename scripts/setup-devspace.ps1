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

  & npm @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "npm $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
  }
}

function Write-Utf8NoBom {
  param(
    [string]$Path,
    [string]$Content
  )

  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

function Read-JsonObject {
  param([string]$Path)

  try {
    $parsed = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  } catch {
    throw "Unable to read JSON file $Path. $($_.Exception.Message)"
  }

  if ($null -eq $parsed -or $parsed -isnot [System.Management.Automation.PSCustomObject]) {
    throw "JSON file $Path must contain an object."
  }

  $result = [ordered]@{}
  foreach ($property in $parsed.PSObject.Properties) {
    $result[$property.Name] = $property.Value
  }
  return $result
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
  param([string]$Value)

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

function Get-OwnerToken {
  param(
    [string]$AuthPath,
    [switch]$Reset
  )

  if ((Test-Path -LiteralPath $AuthPath) -and -not $Reset) {
    $auth = Read-JsonObject -Path $AuthPath
    $existingToken = [string]$auth["ownerToken"]
    if (-not [string]::IsNullOrWhiteSpace($existingToken)) {
      return $existingToken
    }
  }

  $token = (& node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))").Trim()
  if ([string]::IsNullOrWhiteSpace($token)) {
    throw "Failed to generate the DevSpace Owner password."
  }

  return $token
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
$npmVersionText = (& npm --version).Trim()
$gitVersionText = (& git --version).Trim()
Write-Host "Node: $nodeVersionText"
Write-Host "npm:  $npmVersionText"
Write-Host "Git:  $gitVersionText"
Write-Host "Bash: $gitBashPath"
Write-Host ""

$nodeModulesPath = Join-Path $projectRoot "node_modules"
if ($ForceInstall -or -not (Test-Path -LiteralPath $nodeModulesPath)) {
  # 使用锁文件进行可复现安装；npm 的 postinstall 会同时修复 node-pty 权限。
  if (Test-Path -LiteralPath (Join-Path $projectRoot "package-lock.json")) {
    Write-Host "Installing dependencies from package-lock.json..." -ForegroundColor Cyan
    Invoke-Npm -Arguments @("ci", "--include=dev")
  } else {
    Write-Host "Installing dependencies..." -ForegroundColor Cyan
    Invoke-Npm -Arguments @("install", "--include=dev")
  }
} else {
  Write-Host "Dependencies already exist. Use -ForceInstall to reinstall them." -ForegroundColor DarkGray
}

if (-not $SkipBuild) {
  Write-Host "Building DevSpace..." -ForegroundColor Cyan
  Invoke-Npm -Arguments @("run", "build")
}

# 读取并保留已有的扩展配置，只更新本脚本负责的连接与访问范围字段。
$devspaceDir = if ([string]::IsNullOrWhiteSpace($env:DEVSPACE_CONFIG_DIR)) {
  Join-Path $env:USERPROFILE ".devspace"
} else {
  $env:DEVSPACE_CONFIG_DIR
}
New-Item -ItemType Directory -Force -Path $devspaceDir | Out-Null

$configPath = Join-Path $devspaceDir "config.json"
$existingConfig = if (Test-Path -LiteralPath $configPath) {
  Read-JsonObject -Path $configPath
} else {
  [ordered]@{}
}

$defaultAllowedRoot = Split-Path -Parent $projectRoot
if ($PSBoundParameters.ContainsKey("AllowedRoot")) {
  $resolvedAllowedRoots = Resolve-AllowedRoots -Roots $AllowedRoot
} elseif ($existingConfig.Contains("allowedRoots")) {
  try {
    $resolvedAllowedRoots = Resolve-AllowedRoots -Roots (Get-StringValues $existingConfig["allowedRoots"])
  } catch {
    Write-Warning "Existing allowedRoots cannot be used. Falling back to $defaultAllowedRoot."
    $resolvedAllowedRoots = Resolve-AllowedRoots -Roots @($defaultAllowedRoot)
  }
} else {
  $resolvedAllowedRoots = Resolve-AllowedRoots -Roots @($defaultAllowedRoot)
}

$existingPort = if ($existingConfig.Contains("port")) { $existingConfig["port"] } else { $null }
$resolvedPort = Resolve-Port -IsSpecified ($PSBoundParameters.ContainsKey("Port")) -RequestedPort $Port -ExistingPort $existingPort

$existingPublicBaseUrl = if ($existingConfig.Contains("publicBaseUrl")) { [string]$existingConfig["publicBaseUrl"] } else { $null }
$resolvedPublicBaseUrl = if ($PSBoundParameters.ContainsKey("PublicBaseUrl")) {
  Normalize-PublicBaseUrl -Value $PublicBaseUrl
} else {
  Normalize-PublicBaseUrl -Value $existingPublicBaseUrl
}

$nextConfig = [ordered]@{}
foreach ($entry in $existingConfig.GetEnumerator()) {
  $nextConfig[$entry.Key] = $entry.Value
}
$nextConfig["host"] = "127.0.0.1"
$nextConfig["port"] = $resolvedPort
$nextConfig["allowedRoots"] = @($resolvedAllowedRoots)
$nextConfig["publicBaseUrl"] = $resolvedPublicBaseUrl

Write-Utf8NoBom -Path $configPath -Content (($nextConfig | ConvertTo-Json -Depth 8) + [Environment]::NewLine)

$authPath = Join-Path $devspaceDir "auth.json"
$ownerToken = Get-OwnerToken -AuthPath $authPath -Reset:$ResetToken
$authConfig = [ordered]@{ ownerToken = $ownerToken }
Write-Utf8NoBom -Path $authPath -Content (($authConfig | ConvertTo-Json -Depth 4) + [Environment]::NewLine)

Write-Host ""
Write-Host "Verifying DevSpace configuration..." -ForegroundColor Cyan
& npx --no-install tsx src/cli.ts doctor
if ($LASTEXITCODE -ne 0) {
  throw "DevSpace diagnostic failed with exit code $LASTEXITCODE."
}

Write-Host ""
Write-Host "DevSpace configured successfully." -ForegroundColor Green
Write-Host "Config: $configPath"
Write-Host "Auth:   $authPath"
Write-Host "Allowed roots: $($resolvedAllowedRoots -join ', ')"
Write-Host "Local MCP URL: http://127.0.0.1:$resolvedPort/mcp"

# 没有公网地址时仍允许本机使用，但远程 ChatGPT 连接前必须补充 HTTPS 隧道地址。
if ($resolvedPublicBaseUrl) {
  Write-Host "Public MCP URL: $resolvedPublicBaseUrl/mcp"
} else {
  Write-Warning "No public base URL is configured. Set -PublicBaseUrl after creating an HTTPS tunnel for remote MCP clients."
}

if ($ShowOwnerToken) {
  Write-Host "Owner password: $ownerToken" -ForegroundColor Yellow
} else {
  Write-Host "Owner password was preserved or created in auth.json. Use -ShowOwnerToken only when you need to view it." -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "Start development mode with: npm run dev" -ForegroundColor Yellow
