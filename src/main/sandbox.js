// Learning mode: scripts run inside Windows Sandbox, a throwaway VM that is wiped when it
// stops. Networking is off, so scripts can't reach AD, servers or the internet; the only
// host folders it sees are the runtimes (read-only) and a jobs folder.
//
// Speed: one sandbox is booted in the background ("warm") and reused. A small agent inside
// it watches the jobs folder and runs each script, so a run starts in about a second.
// Silence: on Windows 11 24H2+ the `wsb` command starts it with no window at all; on older
// builds the sandbox window is hidden as soon as it appears.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { paths, fill } = require('./paths');
const { findRuntime, onPath } = require('./profiles');

const SANDBOX_EXE = path.join(process.env.windir || 'C:\\Windows', 'System32', 'WindowsSandbox.exe');
const BOX = 'C:\\poly';
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function available() { return process.platform === 'win32' && fs.existsSync(SANDBOX_EXE); }

const AGENT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
# Only one agent per sandbox (boot retries can start extra copies).
$mutex = New-Object System.Threading.Mutex($false, 'Global\PolyIseAgent')
if (-not $mutex.WaitOne(0)) { exit }
$jobs  = 'C:\poly\jobs'     # shared with this PC (slow, lazily synced)
$rt    = 'C:\poly\runtimes' # read-only runtimes from this PC
$local = 'C:\pjobs'         # sandbox-local disk (fast): jobs run and log here
$warmDir = 'C:\pwarm'; $cache = 'C:\pcache'; $csDir = 'C:\pwork\cs'
$inbox = 'C:\pinbox'        # local signals pushed in by the PC with wsb exec (instant)
foreach ($d in $local, $warmDir, $cache, $csDir, $inbox) { New-Item -ItemType Directory $d -Force | Out-Null }
$running = @{}; $off = @{}; $tries = @{}; $rdir = @{}; $seen = @{}; $disp = @{}; $checks = @{}; $done = @{}; $lastScan = 0
function Now { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
$csJob = $null; $csWarm = $null

# Same environment run.cmd uses, so warm-up work fills the same caches.
$env:PATH = "$rt\python;$rt\python\Scripts;$rt\node;$rt\go\bin;$rt\git\bin;$rt\dotnet;" + $env:PATH
$env:GOCACHE = "$cache\go-build"; $env:GOPATH = "$cache\gopath"; $env:GOTOOLCHAIN = 'local'; $env:GOTELEMETRY = 'off'
$env:DOTNET_ROOT = "$rt\dotnet"; $env:DOTNET_CLI_HOME = "$cache\dotnet-home"; $env:NUGET_PACKAGES = "$cache\nuget"
$env:DOTNET_NOLOGO = '1'; $env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'; $env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:PYTHONIOENCODING = 'utf-8'; $env:PYTHONDONTWRITEBYTECODE = '1'
# Practice folders mapped from the PC (same names Live mode uses).
$env:POLY_DATA = 'C:\poly\data'; $env:POLY_OUTPUT = 'C:\poly\output'

# No network in here: don't let Windows wait on certificate revocation downloads.
$k = 'HKLM:\SOFTWARE\Policies\Microsoft\SystemCertificates\ChainEngine\Config'
New-Item $k -Force | Out-Null
Set-ItemProperty $k ChainUrlRetrievalTimeoutMilliseconds 1 -Type DWord
Set-ItemProperty $k ChainRevAccumulativeUrlRetrievalTimeoutMilliseconds 1 -Type DWord

# A PowerShell that has already started and waits for a job: skips PowerShell's slow startup.
$worker = @'
param($token)
$ErrorActionPreference = 'Continue'
Import-Module Microsoft.PowerShell.Utility, Microsoft.PowerShell.Management
$null = Get-Date | Out-String -Stream
$go = "C:\pwarm\$token.go"
while (-not (Test-Path $go)) { Start-Sleep -Milliseconds 30 }
$d = [IO.File]::ReadAllText($go).Trim()
Set-Location -LiteralPath $d
$log = Join-Path $d 'out.log'
$enc = New-Object System.Text.UTF8Encoding($false)
$nl = [Environment]::NewLine
$rc = 0
try {
  $global:LASTEXITCODE = 0
  & (Join-Path $d 'script.ps1') *>&1 | Out-String -Stream -Width 200 | ForEach-Object { [IO.File]::AppendAllText($log, $_ + $nl, $enc) }
  if ($global:LASTEXITCODE) { $rc = $global:LASTEXITCODE }
} catch {
  [IO.File]::AppendAllText($log, ($_ | Out-String), $enc); $rc = 1
}
[IO.File]::WriteAllText((Join-Path $d 'rc.txt'), [string]$rc)
exit $rc
'@
[IO.File]::WriteAllText("$warmDir\worker.ps1", $worker)
# Shared setup every run.cmd calls (written by the PC before boot), kept locally so run.cmd stays tiny.
foreach ($h in 'env.cmd', 'csrun.cmd') { if (Test-Path "$jobs\$h") { Copy-Item "$jobs\$h" "$warmDir\$h" -Force } }
function NewWarm {
  $t = [guid]::NewGuid().ToString('N')
  $p = Start-Process powershell.exe -ArgumentList '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "$warmDir\worker.ps1", $t -WindowStyle Hidden -PassThru
  return @{ token = $t; proc = $p }
}
$warm = NewWarm

# Warm up each installed runtime in the background so the first real run is quick.
if (Test-Path "$rt\python\python.exe") { Start-Process "$rt\python\python.exe" -ArgumentList '-c', 'import os, sys, json, re, random, datetime' -WindowStyle Hidden }
if (Test-Path "$rt\node\node.exe") { Start-Process "$rt\node\node.exe" -ArgumentList '-e', 'require("fs");require("path")' -WindowStyle Hidden }
# Go checks its whole standard library on every build, which is slow over the shared folder.
# Copy the toolchain to local disk (run.cmd switches to it once .ready exists), then warm the cache.
if (Test-Path "$rt\go\bin\go.exe") {
  [IO.File]::WriteAllText("$warmDir\hello.go", 'package main' + [Environment]::NewLine + 'import ("fmt"; "os"; "strings"; "time")' + [Environment]::NewLine + 'func main() { fmt.Println(strings.ToUpper("x"), os.Args, time.Now()) }')
  $goCmd = 'robocopy "' + "$rt\go" + '" C:\pgo /E /MT:8 /R:1 /W:1 /NFL /NDL /NJH /NJS /NP >nul & type nul > C:\pgo\.ready & C:\pgo\bin\go.exe build -o ' + "$warmDir\hello.exe $warmDir\hello.go"
  Start-Process cmd.exe -ArgumentList '/c', $goCmd -WorkingDirectory $warmDir -WindowStyle Hidden
}
# Rust: same idea as Go. rustc loads large compiler files, so copy the toolchain (minus the
# library source, which only IntelliSense uses) to local disk, then warm it with a tiny build.
if (Test-Path "$rt\rust\bin\rustc.exe") {
  [IO.File]::WriteAllText("$warmDir\hello.rs", 'fn main() { println!("warm"); }')
  $rsCmd = 'robocopy "' + "$rt\rust" + '" C:\prust /E /MT:8 /R:1 /W:1 /XD "' + "$rt\rust\lib\rustlib\src" + '" /NFL /NDL /NJH /NJS /NP >nul & type nul > C:\prust\.ready & C:\prust\bin\rustc.exe ' + "$warmDir\hello.rs -o $warmDir\hello-rs.exe"
  Start-Process cmd.exe -ArgumentList '/c', $rsCmd -WorkingDirectory $warmDir -WindowStyle Hidden
}
# C#: compile a tiny program the same way real runs do, to start the compiler server early.
if ((Test-Path "$rt\dotnet\dotnet.exe") -and (Test-Path "$jobs\cswarm.cmd")) {
  $cw = "$warmDir\cs"; New-Item -ItemType Directory $cw -Force | Out-Null
  Copy-Item "$jobs\cswarm.cmd" "$cw\run.cmd" -Force
  Copy-Item "$jobs\cswarm.cs" "$cw\script.cs" -Force
  Copy-Item "$jobs\globalusings.cs" "$cw\globalusings.cs" -Force
  # Copy just what the C# compiler needs to local disk, then warm it up (starts the compiler server).
  $d = "$rt\dotnet"; $q = ' /E /MT:8 /R:1 /W:1 /NFL /NDL /NJH /NJS /NP >nul'
  $dnCmd = 'robocopy "' + $d + '" C:\pdn dotnet.exe /R:1 /W:1 /NFL /NDL /NJH /NJS /NP >nul' +
    ' & robocopy "' + $d + '\host" C:\pdn\host' + $q +
    ' & robocopy "' + $d + '\shared\Microsoft.NETCore.App" C:\pdn\shared\Microsoft.NETCore.App' + $q +
    ' & robocopy "' + $d + '\packs\Microsoft.NETCore.App.Ref" C:\pdn\packs\Microsoft.NETCore.App.Ref' + $q +
    ' & (for /d %S in ("' + $d + '\sdk\*") do (robocopy "%S\Roslyn" "C:\pdn\sdk\%~nxS\Roslyn"' + $q + '))' +
    ' & (if exist C:\pdn\dotnet.exe type nul > C:\pdn\.ready)' +
    ' & call "' + $cw + '\run.cmd"'
  Start-Process cmd.exe -ArgumentList '/c', $dnCmd -WorkingDirectory $cw -WindowStyle Hidden
}

# Copy new output from the job's local log to the shared log; the agent counts every byte it sends.
function Pump($id) {
  $src = Join-Path $rdir[$id] 'out.log'
  if (-not (Test-Path $src)) { return }
  $n = 0
  try {
    $fs = [IO.File]::Open($src, 'Open', 'Read', 'ReadWrite')
    $len = $fs.Length - $off[$id]
    if ($len -gt 0) { $buf = New-Object byte[] $len; [void]$fs.Seek($off[$id], 'Begin'); $n = $fs.Read($buf, 0, $len) }
    $fs.Close()
  } catch { return }
  if ($n -gt 0) {
    $o = [IO.File]::Open("$jobs\$id\out.log", 'Append', 'Write', 'ReadWrite'); $o.Write($buf, 0, $n); $o.Flush(); $o.Close()
    $off[$id] += $n
  }
}

Set-Content "$jobs\ready" (Get-Date -Format o)
while ($true) {
  # New jobs: the PC signals each one through the local inbox (instant). The shared folder is
  # also scanned once a second as a fallback, since it can take seconds to show new files.
  $cands = @()
  foreach ($x in [IO.Directory]::GetFiles($inbox, '*.go')) { $cands += [IO.Path]::GetFileNameWithoutExtension($x) }
  foreach ($x in [IO.Directory]::GetFiles($inbox, '*.pkg')) { $cands += [IO.Path]::GetFileNameWithoutExtension($x) }
  if ((Now) - $lastScan -gt 1000) {
    $lastScan = Now
    foreach ($x in [IO.Directory]::GetFiles($jobs, '*.job')) { $cands += [IO.Path]::GetFileNameWithoutExtension($x) }
  }
  foreach ($id in ($cands | Select-Object -Unique)) {
    if ($done.ContainsKey($id)) { [IO.File]::Delete("$inbox\$id.go"); [IO.File]::Delete("$inbox\$id.pkg"); continue }
    $jf = "$jobs\$id.job"; $dir = Join-Path $jobs $id
    # Files written on the PC can show up here before their contents do. The .job file lists
    # each file's exact size; wait until all of it has arrived.
    if (-not $tries.ContainsKey($id)) { $tries[$id] = 0; $seen[$id] = Now }
    $tries[$id]++
    $files = @{}; $flags = @()
    $pkg = "$inbox\$id.pkg"
    if ([IO.File]::Exists($pkg)) {
      # Small jobs arrive whole in a local package (pushed with wsb exec): no waiting on the share.
      $ok = $true
      try {
        foreach ($line in [IO.File]::ReadAllLines($pkg)) {
          $line = $line.Trim()
          if (-not $line) { continue }
          if ($line.StartsWith('@')) { $flags += $line.Substring(1); continue }
          $name, $b64 = $line -split ' ', 2
          $files[$name] = [Convert]::FromBase64String($b64)
        }
      } catch { $ok = $false }
      $spec = ''
    } else {
      $spec = ''; try { $spec = [IO.File]::ReadAllText($jf) } catch {}
      $ok = [bool]$spec.Trim()
    }
    if ($ok -and $spec) {
      foreach ($line in ($spec -split '\r?\n')) {
        $line = $line.Trim()
        if (-not $line) { continue }
        if ($line.StartsWith('@')) { $flags += $line.Substring(1); continue }
        $name, $size = $line -split ' '
        $b = $null; try { $b = [IO.File]::ReadAllBytes("$dir\$name") } catch {}
        if ($null -eq $b -or $b.Length -ne [int]$size) { $ok = $false; break }
        $files[$name] = $b
      }
    }
    if (-not $ok -and $tries[$id] -lt 150) { continue }
    [IO.File]::Delete($jf); [IO.File]::Delete("$inbox\$id.go"); [IO.File]::Delete("$inbox\$id.pkg"); $done[$id] = 1
    $nTries = $tries[$id]; $tries.Remove($id); $disp[$id] = Now
    # C# runs from one fixed folder when it's free, so .NET can reuse its last build.
    $rd = "$local\$id"
    if ($ok -and ($flags -contains 'fixed cs') -and -not ($csJob -and $running.ContainsKey($csJob)) -and -not ($csWarm -and -not $csWarm.HasExited)) {
      $rd = $csDir; $csJob = $id
      Remove-Item "$rd\out.log", "$rd\rc.txt" -Force
    }
    New-Item -ItemType Directory $rd -Force | Out-Null
    $rdir[$id] = $rd; $off[$id] = 0
    if ($ok) {
      foreach ($name in $files.Keys) { [IO.File]::WriteAllBytes("$rd\$name", $files[$name]) }
      if (($flags -contains 'warm ps') -and $warm -and -not $warm.proc.HasExited) {
        [IO.File]::WriteAllText("$warmDir\$($warm.token).tmp", $rd)
        Move-Item "$warmDir\$($warm.token).tmp" "$warmDir\$($warm.token).go" -Force
        $p = $warm.proc
        $warm = NewWarm
      } else {
        $p = Start-Process cmd.exe -ArgumentList '/c', ('"' + $rd + '\run.cmd"') -WorkingDirectory $rd -WindowStyle Hidden -PassThru
      }
    } else {
      [IO.File]::WriteAllText("$rd\out.log", "POLY-ISE: the script never fully reached the sandbox. Try running it again." + [Environment]::NewLine)
      [IO.File]::WriteAllText("$rd\rc.txt", '1')
      $p = Start-Process cmd.exe -ArgumentList '/c', 'exit 1' -WindowStyle Hidden -PassThru
    }
    $running[$id] = $p; $checks[$id] = $nTries
  }
  foreach ($id in @($running.Keys)) {
    $p = $running[$id]
    if ((Test-Path "$inbox\$id.kill") -or (Test-Path "$jobs\$id.kill")) {
      & taskkill.exe /T /F /PID $p.Id | Out-Null
      Remove-Item "$jobs\$id.kill", "$inbox\$id.kill" -Force
      $running.Remove($id)
      continue
    }
    Pump $id
    if ($p.HasExited) {
      Start-Sleep -Milliseconds 30
      Pump $id
      $rc = (Get-Content (Join-Path $rdir[$id] 'rc.txt') -Raw)
      if ($rc) { $rc = $rc.Trim() } else { $rc = '1' }
      # exit code, output bytes, then timings for the console: when the job was seen and started.
      [IO.File]::WriteAllText("$jobs\$id\exitcode.tmp", "$rc $($off[$id]) $($seen[$id]) $($disp[$id]) $($checks[$id])")
      Move-Item "$jobs\$id\exitcode.tmp" "$jobs\$id\exitcode.txt" -Force
      $running.Remove($id)
    }
  }
  if ($warm -and $warm.proc.HasExited) { $warm = NewWarm }
  Start-Sleep -Milliseconds 80
}
`;

// Hides the classic Windows Sandbox window as soon as it appears (fallback path only).
const HIDE = String.raw`
Add-Type -Namespace P -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);'
for ($i = 0; $i -lt 400; $i++) {
  Get-Process WindowsSandbox, WindowsSandboxClient, WindowsSandboxRemoteSession -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [P.W]::ShowWindow($_.MainWindowHandle, 0) | Out-Null }
  Start-Sleep -Milliseconds 150
}
`;

// C# in the sandbox: compile straight with the SDK's C# compiler (and its compiler server)
// instead of `dotnet run`, which does a full, slow project build every time.
const GLOBAL_USINGS = ['System', 'System.Collections.Generic', 'System.IO', 'System.Linq', 'System.Net.Http',
  'System.Threading', 'System.Threading.Tasks'].map((n) => `global using ${n};`).join('\r\n') + '\r\n';
function csLines(here, log) {
  const DN = `${BOX}\\runtimes\\dotnet`;
  return [
    // Use the agent's local copy of the compiler pieces once it's ready (much faster to load).
    `set "DN=${DN}"`, 'if exist C:\\pdn\\.ready set "DN=C:\\pdn"',
    'set "DOTNET_ROOT=%DN%"', 'set "DOTNET_HOST_PATH=%DN%\\dotnet.exe"',
    'for /d %%S in ("%DN%\\sdk\\*") do set "SDK=%%S"',
    'for /d %%R in ("%DN%\\packs\\Microsoft.NETCore.App.Ref\\*") do set "REF=%%R"',
    'for /d %%F in ("%REF%\\ref\\net*") do set "REFD=%%F"',
    'for %%F in ("%REFD%") do set "TFM=%%~nxF"',
    'for /d %%V in ("%DN%\\shared\\Microsoft.NETCore.App\\*") do set "FXV=%%~nxV"',
    'if not exist "C:\\pcache\\csrefs-%TFM%.rsp" (for %%D in ("%REFD%\\*.dll") do @echo -r:"%%D")> "C:\\pcache\\csrefs-%TFM%.rsp"',
    `"%DN%\\dotnet.exe" "%SDK%\\Roslyn\\bincore\\csc.dll" -nologo -shared -target:exe -langversion:latest -nullable:enable -debug- -out:"${here}script.dll" @"C:\\pcache\\csrefs-%TFM%.rsp" "${here}globalusings.cs" "${here}script.cs" >> "${log}" 2>&1`,
    'if errorlevel 1 goto done',
    `> "${here}script.runtimeconfig.json" echo {"runtimeOptions":{"tfm":"%TFM%","framework":{"name":"Microsoft.NETCore.App","version":"%FXV%"}}}`,
    `"%DN%\\dotnet.exe" "${here}script.dll" >> "${log}" 2>&1`
  ];
}
function cmdHeader() {
  const C = 'C:\\pcache';
  return [
    'chcp 65001 >nul',
    `set "PATH=${BOX}\\runtimes\\python;${BOX}\\runtimes\\python\\Scripts;${BOX}\\runtimes\\node;${BOX}\\runtimes\\go\\bin;${BOX}\\runtimes\\rust\\bin;${BOX}\\runtimes\\git\\bin;${BOX}\\runtimes\\dotnet;%PATH%"`,
    `set "DOTNET_ROOT=${BOX}\\runtimes\\dotnet"`, `set "DOTNET_CLI_HOME=${C}\\dotnet-home"`, `set "NUGET_PACKAGES=${C}\\nuget"`,
    'set DOTNET_NOLOGO=1', 'set DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1', 'set DOTNET_CLI_TELEMETRY_OPTOUT=1',
    // Build caches live on the sandbox's own disk (fast); the agent pre-fills them at boot.
    `set "GOCACHE=${C}\\go-build"`, `set "GOPATH=${C}\\gopath"`, 'set GOTELEMETRY=off', 'set GOTOOLCHAIN=local',
    // Use the local copy of Go once the agent has finished copying it.
    `set "GOEXE=${BOX}\\runtimes\\go\\bin\\go.exe"`, 'if exist C:\\pgo\\.ready set "GOEXE=C:\\pgo\\bin\\go.exe"',
    `set "RUSTC=${BOX}\\runtimes\\rust\\bin\\rustc.exe"`, 'if exist C:\\prust\\.ready set "RUSTC=C:\\prust\\bin\\rustc.exe"',
    'set PYTHONIOENCODING=utf-8', 'set PYTHONDONTWRITEBYTECODE=1',
    `set "POLY_DATA=${BOX}\\data"`, `set "POLY_OUTPUT=${BOX}\\output"`
  ];
}
// Start of every run.cmd: shared setup from the agent's local copy, then the job's own folder.
function runHead() { return ['@echo off', 'call C:\\pwarm\\env.cmd', 'cd /d "%~dp0"']; }
function csCall() { return ['call C:\\pwarm\\csrun.cmd "%~dp0" "%~dp0out.log"']; }

class Sandbox {
  constructor(send) {
    this.send = send;
    this.dir = path.join(paths.data, 'sandbox', 'session');
    this.jobsDir = path.join(this.dir, 'jobs');   // replaced with a fresh folder on every boot
    this.idsFile = path.join(this.dir, 'wsb-ids.txt'); // sandboxes we started, stopped on next boot
    // Build caches for Learning runs (Go, .NET). Kept between sandbox restarts so only the very
    // first Go/C# run is slow. Used only by the sandbox, never by Live runs.
    this.cacheDir = path.join(paths.data, 'sandbox', 'cache');
    this.state = 'off';       // off | booting | ready | failed
    this.bootPromise = null;
    this.wsbId = null;
    this.children = [];
    this.runs = new Map();    // tabId -> { id, dir, offset, timer, started, ready }
    this.seq = 0;
  }

  out(stream, text, tabId) { this.send('console:data', { stream, text, tabId }); }
  status(extra = {}) { this.send('sandbox:state', { state: this.state, ...extra }); }

  config(withLogon) {
    return `<Configuration>
  <VGpu>Disable</VGpu><Networking>Disable</Networking><ClipboardRedirection>Disable</ClipboardRedirection>
  <PrinterRedirection>Disable</PrinterRedirection><AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput>
  <MemoryInMB>4096</MemoryInMB>
  <MappedFolders>
    <MappedFolder><HostFolder>${xml(path.resolve(paths.runtimes))}</HostFolder><SandboxFolder>${BOX}\\runtimes</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>${xml(this.jobsDir)}</HostFolder><SandboxFolder>${BOX}\\jobs</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>${xml(this.cacheDir)}</HostFolder><SandboxFolder>${BOX}\\cache</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>${xml(paths.practiceData)}</HostFolder><SandboxFolder>${BOX}\\data</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>${xml(paths.practiceOutput)}</HostFolder><SandboxFolder>${BOX}\\output</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  ${withLogon ? `<LogonCommand><Command>powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ${BOX}\\jobs\\agent.ps1</Command></LogonCommand>` : ''}
</Configuration>`;
  }

  // Boot the shared sandbox once; later calls reuse it.
  ensure() {
    if (this.state === 'ready') return Promise.resolve(true);
    if (this.bootPromise) return this.bootPromise;
    if (!available()) return Promise.resolve(false);
    this.bootPromise = this.boot().finally(() => { this.bootPromise = null; });
    return this.bootPromise;
  }

  async boot() {
    this.state = 'booting'; this.status();
    await this.stopLeftovers();
    // A fresh jobs folder per boot: an old sandbox that is somehow still running can never
    // pick up these jobs, because it watches a different folder.
    fs.mkdirSync(this.dir, { recursive: true });
    for (const n of fs.readdirSync(this.dir)) {
      if (n === 'jobs' || n.startsWith('jobs-')) { try { fs.rmSync(path.join(this.dir, n), { recursive: true, force: true }); } catch { /* still in use */ } }
    }
    this.jobsDir = path.join(this.dir, `jobs-${Date.now()}`);
    fs.mkdirSync(path.join(paths.runtimes), { recursive: true });
    fs.mkdirSync(this.jobsDir, { recursive: true });
    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.writeFileSync(path.join(this.jobsDir, 'agent.ps1'), AGENT);
    // Files the agent uses to warm up the C# compiler right after boot.
    // Shared setup that every run.cmd calls, so run.cmd itself stays small enough to send inline.
    fs.writeFileSync(path.join(this.jobsDir, 'env.cmd'), cmdHeader().join('\r\n'));
    fs.writeFileSync(path.join(this.jobsDir, 'csrun.cmd'), ['@echo off', ...csLines('%~1', '%~2'), ':done', 'exit /b %errorlevel%'].join('\r\n'));
    fs.writeFileSync(path.join(this.jobsDir, 'cswarm.cmd'), runHead().concat(csCall()).join('\r\n'));
    fs.writeFileSync(path.join(this.jobsDir, 'cswarm.cs'), 'Console.WriteLine("warm");\r\n');
    fs.writeFileSync(path.join(this.jobsDir, 'globalusings.cs'), GLOBAL_USINGS);
    const started = Date.now();
    const wsb = onPath('wsb');
    let ok = false;
    if (wsb) ok = await this.bootHeadless(wsb);
    if (!ok) ok = await this.bootHidden();
    if (ok) ok = await this.waitFor(path.join(this.jobsDir, 'ready'), 120000);
    this.state = ok ? 'ready' : 'failed';
    this.status({ seconds: Math.round((Date.now() - started) / 1000) });
    if (!ok) this.shutdown();
    return ok;
  }

  // Windows 11 24H2+: `wsb start` runs the sandbox with no window; the agent is started with `wsb exec`.
  async bootHeadless(wsb) {
    const startOut = await new Promise((resolve) => {
      execFile(wsb, ['start', '--config', this.config(false)], { windowsHide: true, timeout: 120000 }, (err, stdout, stderr) => resolve(err ? null : String(stdout) + String(stderr)));
    });
    const m = startOut && /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(startOut);
    if (!m) return false;
    this.wsbId = m[1];
    try { fs.appendFileSync(this.idsFile, this.wsbId + '\n'); } catch { /* ignore */ }
    // The VM may still be booting: keep trying to start the agent until it answers.
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const child = spawn(wsb, ['exec', '--id', this.wsbId, '-c',
        `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ${BOX}\\jobs\\agent.ps1`, '-r', 'System'], { windowsHide: true });
      this.children.push(child);
      if (await this.waitFor(path.join(this.jobsDir, 'ready'), 8000)) return true;
      try { child.kill(); } catch { /* ignore */ }
    }
    // Headless start didn't work: remove it so the classic fallback can start (one sandbox max).
    await new Promise((r) => execFile(wsb, ['stop', '--id', this.wsbId], { windowsHide: true }, () => r()));
    this.wsbId = null;
    await new Promise((r) => setTimeout(r, 2000));
    return false;
  }

  // Tell the agent about a job (or a kill) right away through a sandbox-local file, instead of
  // waiting for the shared folder to show it (that can take several seconds).
  signal(name) { this.exec(`cmd.exe /c type nul > C:\\pinbox\\${name}`); }
  exec(cmdline) {
    const wsb = this.wsbId && onPath('wsb');
    if (!wsb) return;
    execFile(wsb, ['exec', '--id', this.wsbId, '-c', cmdline, '-r', 'System'], { windowsHide: true, timeout: 20000 }, () => {});
  }

  // Stop sandboxes left running by an earlier POLY-ISE that was closed without shutting down
  // (for example by an installer upgrade).
  async stopLeftovers() {
    let ids = [];
    try { ids = fs.readFileSync(this.idsFile, 'utf8').split(/\s+/).filter(Boolean); } catch { /* none */ }
    const wsb = onPath('wsb');
    if (wsb) {
      for (const id of ids) await new Promise((r) => execFile(wsb, ['stop', '--id', id], { windowsHide: true, timeout: 30000 }, () => r()));
    }
    try { fs.rmSync(this.idsFile, { force: true }); } catch { /* ignore */ }
  }

  // Older builds: classic WindowsSandbox.exe, with its window hidden as soon as it shows up.
  async bootHidden() {
    const wsbFile = path.join(this.dir, 'learning.wsb');
    fs.writeFileSync(wsbFile, this.config(true));
    const hider = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', HIDE], { windowsHide: true });
    this.children.push(hider);
    const vm = spawn(SANDBOX_EXE, [wsbFile], { windowsHide: true });
    this.children.push(vm);
    return new Promise((resolve) => { vm.on('error', () => resolve(false)); setTimeout(() => resolve(true), 500); });
  }

  waitFor(file, ms) {
    return new Promise((resolve) => {
      const end = Date.now() + ms;
      const t = setInterval(() => {
        if (fs.existsSync(file)) { clearInterval(t); resolve(true); } else if (Date.now() > end) { clearInterval(t); resolve(false); }
      }, 150);
    });
  }

  // Where a runtime lives inside the sandbox, or null if it can't be used there.
  boxRuntime(profile) {
    const rt = findRuntime(profile);
    if (!rt.found) return null;
    const root = path.resolve(paths.runtimes);
    const p = path.resolve(rt.path);
    if (p.toLowerCase().startsWith(root.toLowerCase())) return BOX + '\\runtimes' + p.slice(root.length);
    if (profile.id === 'ps' && /windowspowershell/i.test(p)) return 'powershell.exe'; // built into every Windows image
    return null;
  }

  async run(profile, sourceFile, tabId) {
    if (!available()) {
      this.out('err', 'Learning mode needs Windows Sandbox, which is not turned on for this PC.\n', tabId);
      this.send('sandbox:missing', {});
      return;
    }
    if (!profile.run) { this.out('err', `${profile.name} has no run command.\n`, tabId); return; }
    const runtime = this.boxRuntime(profile);
    if (!runtime) {
      this.out('err', `Learning mode needs ${profile.runtime.label} installed by POLY-ISE (the sandbox can't see programs installed on this PC). Install it from Servers → Setup wizard.\n`, tabId);
      return;
    }
    this.stop(tabId, true);
    this.send('run:state', { tabId, running: true });
    const started = Date.now();
    if (this.state !== 'ready') this.out('sys', 'Starting the Learning sandbox in the background (only the first run waits for this)…\n', tabId);
    if (!(await this.ensure())) {
      this.out('err', 'The Learning sandbox could not start. Check that virtualization is enabled, or switch to Live.\n', tabId);
      this.send('run:state', { tabId, running: false });
      return;
    }

    const id = `job${Date.now()}${++this.seq}`;
    const dir = path.join(this.jobsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(sourceFile) || profile.extensions[0];
    fs.copyFileSync(sourceFile, path.join(dir, 'script' + ext));
    // run.cmd works from whatever folder the agent runs it in (%~dp0), usually C:\pjobs\<id>.
    const here = '%~dp0';
    const v = { runtime: `"${runtime}"`, file: `${here}script${ext}`, dir: `${here}.`, out: `${here}build.exe` };
    const log = `${here}out.log`;
    const lines = runHead();
    if (profile.id === 'go') v.runtime = '"%GOEXE%"';
    if (profile.id === 'rs') v.runtime = '"%RUSTC%"';
    // C# compiles with csc directly (see csLines); other languages use their profile's run steps.
    const extraFiles = [];
    const flags = [];
    let extraArgs = '';
    if (runtime === 'powershell.exe') flags.push('@warm ps'); // run in an already-started PowerShell
    if (profile.id === 'cs') {
      fs.writeFileSync(path.join(dir, 'globalusings.cs'), GLOBAL_USINGS);
      extraFiles.push('globalusings.cs');
      lines.push(...csCall());
    } else {
      for (const step of profile.run) {
        lines.push(`${fill(step, v)}${extraArgs} >> "${log}" 2>&1`);
        lines.push('if errorlevel 1 goto done');
      }
    }
    // Exit code goes next to the log; the agent forwards it with the exact byte count.
    lines.push(':done', `> "${here}rc.txt" echo %errorlevel%`);
    const cmdText = Buffer.from(lines.join('\r\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'run.cmd'), cmdText);
    const scriptBytes = fs.statSync(path.join(dir, 'script' + ext)).size;
    // The agent picks this up; the sizes let it wait until every file has fully synced.
    fs.writeFileSync(path.join(this.jobsDir, id + '.job'), `script${ext} ${scriptBytes}\r\nrun.cmd ${cmdText.length}\r\n` +
      extraFiles.map((n) => `${n} ${fs.statSync(path.join(dir, n)).size}\r\n`).join('') + flags.map((f) => f + '\r\n').join(''));
    // Small jobs travel inside the wsb exec command itself (cmd's line limit is 8191 chars), so the
    // sandbox doesn't wait for the shared folder to sync. Bigger ones fall back to the share.
    const b64 = (f) => fs.readFileSync(path.join(dir, f)).toString('base64');
    const pkgLines = [`script${ext} ${b64('script' + ext)}`, `run.cmd ${cmdText.toString('base64')}`,
      ...extraFiles.map((n) => `${n} ${b64(n)}`), ...flags];
    const inbox = 'C:\\pinbox\\';
    const pkgCmd = `cmd.exe /c (${pkgLines.map((l) => 'echo ' + l).join('& ')})> ${inbox}${id}.tmp && move /y ${inbox}${id}.tmp ${inbox}${id}.pkg >nul`;
    if (pkgCmd.length < 7800) this.exec(pkgCmd); else this.signal(id + '.go');

    this.out('sys', `▶ ${path.basename(sourceFile)} · Learning sandbox\n`, tabId);
    const r = { id, dir, offset: 0, started };
    r.timer = setInterval(() => this.poll(tabId), 150);
    this.runs.set(tabId, r);
  }

  // Send any new output from the job's log to the console.
  readLog(tabId, r) {
    const logFile = path.join(r.dir, 'out.log');
    try {
      const size = fs.statSync(logFile).size;
      if (size <= r.offset) return;
      const fd = fs.openSync(logFile, 'r');
      const buf = Buffer.alloc(size - r.offset);
      fs.readSync(fd, buf, 0, buf.length, r.offset);
      fs.closeSync(fd);
      r.offset = size;
      this.out('out', buf.toString('utf8'), tabId);
    } catch { /* not created yet */ }
  }

  poll(tabId) {
    const r = this.runs.get(tabId);
    if (!r) return;
    const exitFile = path.join(r.dir, 'exitcode.txt');
    const before = r.offset;
    this.readLog(tabId, r);
    if (!r.doneAt && fs.existsSync(exitFile)) r.doneAt = Date.now();
    if (!r.doneAt) return;
    // The sandbox syncs files back to this PC lazily: the exit marker can arrive before the
    // output. The marker holds "<exit code> <log bytes>", so wait until all bytes are here.
    let raw = '';
    try { raw = fs.readFileSync(exitFile, 'utf8').trim(); } catch { /* still syncing */ }
    const [codeS, sizeS, seenS, dispS, checksS] = raw.split(/\s+/);
    const code = parseInt(codeS, 10), want = parseInt(sizeS, 10) || 0;
    const waited = Date.now() - r.doneAt;
    if ((Number.isNaN(code) || r.offset < want) && waited < 15000) return;
    if (r.offset < want) this.out('err', `(some output may be missing: got ${r.offset} of ${want} bytes)\n`, tabId);
    // Show where the time went when the sandbox was slow to start the job.
    const created = Number(r.id.slice(3, 16)), seen = Number(seenS), disp = Number(dispS);
    if (seen && disp && disp - created > 1500) {
      this.out('sys', `⏱ start delay ${((disp - created) / 1000).toFixed(1)}s: sandbox saw the job after ${((seen - created) / 1000).toFixed(1)}s, files ready ${((disp - seen) / 1000).toFixed(1)}s later (${checksS} checks)\n`, tabId);
    }
    const n = code;
    this.finish(tabId, Number.isNaN(n) ? 1 : n);
  }

  finish(tabId, code, quiet) {
    const r = this.runs.get(tabId);
    if (!r) return;
    clearInterval(r.timer);
    this.runs.delete(tabId);
    this.send('run:state', { tabId, running: false });
    if (!quiet && code !== null) {
      const secs = ((Date.now() - r.started) / 1000).toFixed(2);
      this.out('sys', code === 0 ? `■ done in ${secs}s · sandboxed, nothing changed on this PC\n` : `■ exited with code ${code} · sandboxed\n`, tabId);
      this.send('console:done', { code, tabId });
    }
    setTimeout(() => fs.rm(r.dir, { recursive: true, force: true }, () => {}), 3000);
  }

  stop(tabId, quiet) {
    const ids = tabId ? [tabId] : [...this.runs.keys()];
    let any = false;
    for (const id of ids) {
      const r = this.runs.get(id);
      if (!r) continue;
      try { fs.writeFileSync(path.join(this.jobsDir, r.id + '.kill'), ''); } catch { /* ignore */ }
      this.signal(r.id + '.kill');
      this.finish(id, null, true);
      if (!quiet) this.out('sys', '■ force-stopped\n', id);
      any = true;
    }
    return any;
  }

  // Throw the sandbox away (everything inside is wiped). Used on reset, Live mode and quit.
  shutdown() {
    this.stop(null, true);
    if (this.wsbId) {
      const wsb = onPath('wsb');
      if (wsb) execFile(wsb, ['stop', '--id', this.wsbId], { windowsHide: true }, () => {});
      this.wsbId = null;
    }
    for (const c of this.children) { try { c.kill(); } catch { /* ignore */ } }
    this.children = [];
    for (const im of ['WindowsSandbox.exe', 'WindowsSandboxClient.exe', 'WindowsSandboxRemoteSession.exe']) {
      execFile('taskkill', ['/IM', im, '/F'], { windowsHide: true }, () => {});
    }
    this.state = 'off';
    this.status();
  }

  async reset() { this.shutdown(); await new Promise((r) => setTimeout(r, 1500)); return this.ensure(); }
}

module.exports = { Sandbox, available, SANDBOX_EXE };
