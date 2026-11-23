<#
  Downloads the runtimes that ship inside POLY//ISE (Python + Node) into .\runtimes\.
  PowerShell needs nothing: Windows PowerShell 5.1 is already on every Windows machine.

  By default it finds the newest Python 3.13.x and Node 24 LTS automatically.
  Pass -PythonVersion / -NodeVersion to pin exact versions.
  Prints each file's SHA-256 so you can paste it into catalog\catalog.json.
#>
param(
  [string]$PythonVersion = '',
  [string]$PythonSeries  = '3.13',
  [string]$NodeVersion   = '',
  [string]$NodeMajor     = '24',
  [switch]$IncludePwsh,
  [string]$PwshVersion   = '7.5.4'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # makes Invoke-WebRequest much faster
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $PSScriptRoot
$rt   = Join-Path $root 'runtimes'
$tmp  = Join-Path $root 'data\downloads'
New-Item -ItemType Directory -Force -Path $rt, $tmp | Out-Null

function Get-Zip($url, $name) {
  $file = Join-Path $tmp $name
  Write-Host "Downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing
  $hash = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
  Write-Host "  SHA-256: $hash"
  return $file
}

function Test-Url($url) {
  try { Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing | Out-Null; return $true } catch { return $false }
}

# --- Resolve versions ---
if (-not $NodeVersion) {
  $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
  $pick = $index | Where-Object { $_.lts -and $_.version -like "v$NodeMajor.*" -and $_.files -contains 'win-x64-zip' } | Select-Object -First 1
  if (-not $pick) { throw "No Node $NodeMajor LTS build found." }
  $NodeVersion = $pick.version.TrimStart('v')
}
if (-not $PythonVersion) {
  $listing = (Invoke-WebRequest 'https://www.python.org/ftp/python/' -UseBasicParsing).Content
  $versions = [regex]::Matches($listing, "href=`"($([regex]::Escape($PythonSeries))\.\d+)/`"") |
              ForEach-Object { $_.Groups[1].Value } | Sort-Object { [version]$_ } -Descending -Unique
  foreach ($v in $versions) {
    if (Test-Url "https://www.python.org/ftp/python/$v/python-$v-embed-amd64.zip") { $PythonVersion = $v; break }
  }
  if (-not $PythonVersion) { throw "No Python $PythonSeries embeddable build found." }
}
Write-Host "Python $PythonVersion, Node $NodeVersion"

# --- Python (embeddable zip) ---
$py = Join-Path $rt 'python'
$zip = Get-Zip "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip" 'python.zip'
Remove-Item $py -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive $zip -DestinationPath $py -Force
# The embeddable build ignores site-packages until "import site" is enabled in its ._pth file.
$pth = Get-ChildItem $py -Filter 'python*._pth' | Select-Object -First 1
(Get-Content $pth.FullName) -replace '^#\s*import site', 'import site' | Set-Content $pth.FullName
# Add pip.
$getPip = Join-Path $tmp 'get-pip.py'
Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile $getPip -UseBasicParsing
& (Join-Path $py 'python.exe') $getPip --no-warn-script-location
Write-Host "Python $PythonVersion ready in runtimes\python"

# --- Node (also provides npm, used to install Pyright and the Bash server) ---
$node = Join-Path $rt 'node'
$zip = Get-Zip "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" 'node.zip'
Remove-Item $node -Recurse -Force -ErrorAction SilentlyContinue
$stage = Join-Path $tmp 'node-stage'
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive $zip -DestinationPath $stage -Force
Move-Item (Get-ChildItem $stage | Select-Object -First 1).FullName $node
Remove-Item $stage -Recurse -Force
Write-Host "Node $NodeVersion ready in runtimes\node"

# --- Optional: PowerShell 7 ---
if ($IncludePwsh) {
  $pw = Join-Path $rt 'pwsh'
  $zip = Get-Zip "https://github.com/PowerShell/PowerShell/releases/download/v$PwshVersion/PowerShell-$PwshVersion-win-x64.zip" 'pwsh.zip'
  Remove-Item $pw -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive $zip -DestinationPath $pw -Force
  Write-Host "PowerShell $PwshVersion ready in runtimes\pwsh"
}

Remove-Item (Join-Path $tmp '*.zip'), $getPip -Force -ErrorAction SilentlyContinue
Write-Host 'Done.'
