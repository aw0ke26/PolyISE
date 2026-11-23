<#
.SYNOPSIS
  Unzips POLY//ISE, installs Node.js if needed, and builds the POLY-ISE installer.
  Language runtimes (Python, .NET, etc.) are offered by the app's first-run Setup wizard.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\Build-PolyISE.ps1
  powershell -ExecutionPolicy Bypass -File .\Build-PolyISE.ps1 -NoLaunch
#>
param(
  [string]$ZipFolder   = 'C:\Users\brown\Documents\REsume',
  [string]$Destination = 'C:\Users\brown\Documents\REsume',
  [switch]$NoLaunch        # don't run the installer when done
)

$ErrorActionPreference = 'Stop'

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  [!]  $msg" -ForegroundColor Yellow }

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

function Install-WithWinget($id, $name) {
  if (-not (Have 'winget')) { throw "$name is missing and winget isn't available. Install $name manually, then rerun." }
  $answer = Read-Host "  $name is not installed. Install it now with winget? (Y/N)"
  if ($answer -notmatch '^[Yy]') { return $false }
  winget install --id $id -e --accept-source-agreements --accept-package-agreements
  Refresh-Path
  return $true
}

function Run-Npm($argsLine) {
  Write-Host "  > npm $argsLine" -ForegroundColor DarkGray
  # npm is a .cmd file, so run it through cmd to get a reliable exit code.
  cmd /c "npm $argsLine"
  if ($LASTEXITCODE -ne 0) { throw "npm $argsLine failed (exit code $LASTEXITCODE)." }
}

# ---------------------------------------------------------------- 1. Find + unzip
Step 'Finding the POLY//ISE zip'
$zip = Get-ChildItem -Path $ZipFolder -Filter 'polyise*.zip' -File -ErrorAction Stop |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $zip) { throw "No polyise*.zip found in $ZipFolder" }
Ok "Using $($zip.FullName)"

$project = Join-Path $Destination 'polyise'
if (Test-Path $project) {
  $answer = Read-Host "  $project already exists. Replace it with a fresh copy? Your runtimes\servers\data folders will be kept. (Y/N)"
  if ($answer -match '^[Yy]') {
    $keep = Join-Path $env:TEMP "polyise-keep-$(Get-Random)"
    New-Item -ItemType Directory -Path $keep | Out-Null
    foreach ($d in 'runtimes', 'servers', 'data', 'node_modules') {
      if (Test-Path (Join-Path $project $d)) { Move-Item (Join-Path $project $d) (Join-Path $keep $d) }
    }
    Remove-Item $project -Recurse -Force
    Expand-Archive -Path $zip.FullName -DestinationPath $Destination -Force
    foreach ($d in 'runtimes', 'servers', 'data', 'node_modules') {
      if (Test-Path (Join-Path $keep $d)) {
        Remove-Item (Join-Path $project $d) -Recurse -Force -ErrorAction SilentlyContinue
        Move-Item (Join-Path $keep $d) (Join-Path $project $d)
      }
    }
    Remove-Item $keep -Recurse -Force
    Ok 'Fresh copy unzipped (kept your existing downloads)'
  } else {
    Ok 'Keeping the existing folder'
  }
} else {
  Expand-Archive -Path $zip.FullName -DestinationPath $Destination -Force
  Ok "Unzipped to $project"
}
if (-not (Test-Path (Join-Path $project 'package.json'))) { throw "package.json not found in $project. Is the zip layout right?" }
Set-Location $project

# ---------------------------------------------------------------- 2. Prerequisites
Step 'Checking Node.js'
if (-not (Have 'node')) {
  if (-not (Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js LTS')) { throw 'Node.js is required to build. Stopping.' }
  if (-not (Have 'node')) { throw 'Node.js installed, but this window cannot see it yet. Close PowerShell, open a new one, and rerun.' }
}
Ok "Node $(node --version), npm $(cmd /c npm --version)"

# ---------------------------------------------------------------- 3. Build steps
Step 'Installing packages (npm install)'
Run-Npm 'install --no-audit --no-fund'
Ok 'Packages installed'

Step 'Building the installer (npm run dist)'
Run-Npm 'run dist'
$setup = Get-ChildItem (Join-Path $project 'dist') -Filter 'POLY-ISE-Setup-*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { throw 'Build finished but no installer was found in dist\. Check the output above.' }
Ok "Built $($setup.FullName)"

Write-Host "`nDone. Installer: $($setup.FullName)" -ForegroundColor Green
Write-Host 'Windows SmartScreen may warn because it is unsigned: More info > Run anyway.'
if (-not $NoLaunch) { Start-Process $setup.FullName }
