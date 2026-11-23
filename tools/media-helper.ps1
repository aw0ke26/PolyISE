<#
  POLY//ISE music helper. Runs in Windows PowerShell 5.1 (built into Windows), so it needs
  no .NET SDK or build step. Uses Windows' media session API (the same thing behind the
  volume flyout) for play/pause/skip, and Core Audio for per-app volume.

  Protocol: one command per line on stdin, one JSON object per line on stdout.
  Commands: status | toggle | play | pause | next | prev | select <appId> | vol <0-100>
#>
$ErrorActionPreference = 'Stop'

# ---- WinRT async helper ----
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($op, [Type]$resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
  $null = $task.Wait(5000)
  return $task.Result
}

$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$manager = Await ($mgrType::RequestAsync()) $mgrType

# ---- Core Audio (per-app volume) ----
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace PolyAudio {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int NotImpl1();
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  }

  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    int NotImpl1();
    int NotImpl2();
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnum);
  }

  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, out IAudioSessionControl2 session);
  }

  [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out int state);           // 0 inactive, 1 active, 2 expired
    int NotImpl1(); int NotImpl2(); int NotImpl3(); int NotImpl4();
    int NotImpl5(); int NotImpl6(); int NotImpl7(); int NotImpl8();
    int NotImpl9(); int NotImpl10();
    [PreserveSig] int GetProcessId(out uint pid);
  }

  [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISimpleAudioVolume {
    [PreserveSig] int SetMasterVolume(float level, ref Guid eventContext);
    [PreserveSig] int GetMasterVolume(out float level);
  }

  class Session { public uint Pid; public string Name; public int State; public ISimpleAudioVolume Volume; }

  public static class Mixer {
    public static string LastNote = "";

    static string Norm(string s) {
      var sb = new System.Text.StringBuilder();
      foreach (char c in s.ToLowerInvariant()) if (char.IsLetterOrDigit(c)) sb.Append(c);
      return sb.ToString();
    }

    // "Spotify.exe" -> spotify; "AppleInc.AppleMusicWin_nzyj5cx40ttqa!App" -> applemusicwin; "MSEdge" -> msedge
    static string KeyFromAppId(string appId) {
      string id = appId.Split('!')[0];
      if (id.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) id = id.Substring(0, id.Length - 4);
      int us = id.IndexOf('_'); if (us > 0) id = id.Substring(0, us);
      int dot = id.LastIndexOf('.'); if (dot >= 0 && dot < id.Length - 1) id = id.Substring(dot + 1);
      return Norm(id);
    }

    static bool Similar(string a, string b) {
      if (a.Length == 0 || b.Length == 0) return false;
      if (a.Contains(b) || b.Contains(a)) return true;
      int n = 0; while (n < a.Length && n < b.Length && a[n] == b[n]) n++;
      return n >= 5;
    }

    static List<Session> Sessions() {
      var list = new List<Session>();
      var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
      IMMDevice dev; en.GetDefaultAudioEndpoint(0, 1, out dev);
      var iid = typeof(IAudioSessionManager2).GUID;
      object o; dev.Activate(ref iid, 23, IntPtr.Zero, out o);
      IAudioSessionEnumerator sessions; ((IAudioSessionManager2)o).GetSessionEnumerator(out sessions);
      int count; sessions.GetCount(out count);
      for (int i = 0; i < count; i++) {
        IAudioSessionControl2 ctl; sessions.GetSession(i, out ctl);
        uint pid; ctl.GetProcessId(out pid);
        if (pid == 0) continue; // system sounds
        int state; ctl.GetState(out state);
        string name = "";
        try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { continue; }
        list.Add(new Session { Pid = pid, Name = name, State = state, Volume = (ISimpleAudioVolume)ctl });
      }
      return list;
    }

    // Every audio session that belongs to the app (apps like Chrome or Spotify can have several).
    static List<Session> Find(string appId, int selfPid) {
      var all = Sessions();
      string key = KeyFromAppId(appId);
      var hits = all.FindAll(s => Similar(Norm(s.Name), key));
      if (hits.Count == 0) {
        // Some apps (e.g. Firefox) report a hashed id. Fall back to the one app actually playing audio.
        string selfName = "";
        try { selfName = System.Diagnostics.Process.GetProcessById(selfPid).ProcessName; } catch { }
        var active = all.FindAll(s => s.State == 1 && s.Pid != selfPid && s.Name != selfName);
        if (active.Count == 1) { hits = active; LastNote = "matched by active audio: " + active[0].Name; }
        else LastNote = "no audio session for '" + appId + "'. Sessions: " + string.Join(", ", all.ConvertAll(s => s.Name + (s.State == 1 ? "*" : "")).ToArray());
      } else LastNote = "";
      return hits;
    }

    public static float Get(string appId, int selfPid) {
      var hits = Find(appId, selfPid); if (hits.Count == 0) return -1;
      float level; hits[0].Volume.GetMasterVolume(out level); return level;
    }

    public static bool Set(string appId, int selfPid, float level) {
      var hits = Find(appId, selfPid); if (hits.Count == 0) return false;
      var g = Guid.Empty;
      foreach (var s in hits) s.Volume.SetMasterVolume(level, ref g);
      return true;
    }
  }
}
'@

$selectedId = $null
$selfPid = [int]$env:POLYISE_PID   # the editor's own process, so its UI sounds are never picked

# "Spotify.exe" -> Spotify; "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify" -> Spotify; "MSEdge" -> MSEdge
function Friendly($appId) {
  $parts = $appId -split '!'
  if ($parts.Count -gt 1 -and $parts[1] -and $parts[1] -ne 'App') { return $parts[1] }
  $id = $parts[0] -replace '\.exe$', ''
  $id = ($id -split '_')[0]
  $name = ($id -split '\.')[-1]
  if ([string]::IsNullOrWhiteSpace($name)) { return $appId } else { return $name }
}

function Current {
  $sessions = $manager.GetSessions()
  if ($selectedId) {
    $picked = $sessions | Where-Object { $_.SourceAppUserModelId -eq $selectedId } | Select-Object -First 1
    if ($picked) { return $picked }
  }
  $cur = $manager.GetCurrentSession()
  if ($cur) { return $cur }
  return $sessions | Select-Object -First 1
}

function Send($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}

function Status {
  $cur = Current
  $list = @($manager.GetSessions() | ForEach-Object { @{ id = $_.SourceAppUserModelId; app = (Friendly $_.SourceAppUserModelId) } })
  $current = $null
  if ($cur) {
    $title = ''; $artist = ''
    try { $p = Await ($cur.TryGetMediaPropertiesAsync()) $propsType; $title = $p.Title; $artist = $p.Artist } catch { }
    $playing = ($cur.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Playing')
    $vol = $null
    try { $v = [PolyAudio.Mixer]::Get($cur.SourceAppUserModelId, $selfPid); if ($v -ge 0) { $vol = [math]::Round($v * 100) } } catch { }
    $current = @{ id = $cur.SourceAppUserModelId; app = (Friendly $cur.SourceAppUserModelId); title = $title; artist = $artist; playing = $playing; volume = $vol }
  }
  Send @{ sessions = $list; current = $current }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Trim() -split ' ', 2
  $cmd = $parts[0].ToLower()
  $arg = if ($parts.Count -gt 1) { $parts[1] } else { '' }
  try {
    $cur = Current
    switch ($cmd) {
      'toggle' { if ($cur) { $null = Await ($cur.TryTogglePlayPauseAsync()) ([bool]) } }
      'play'   { if ($cur) { $null = Await ($cur.TryPlayAsync()) ([bool]) } }
      'pause'  { if ($cur) { $null = Await ($cur.TryPauseAsync()) ([bool]) } }
      'next'   { if ($cur) { $null = Await ($cur.TrySkipNextAsync()) ([bool]) } }
      'prev'   { if ($cur) { $null = Await ($cur.TrySkipPreviousAsync()) ([bool]) } }
      'select' { $selectedId = $arg }
      'vol'    {
        if ($cur) {
          $ok = [PolyAudio.Mixer]::Set($cur.SourceAppUserModelId, $selfPid, [math]::Min(100, [math]::Max(0, [int]$arg)) / 100)
          if (-not $ok) { Send @{ volumeError = [PolyAudio.Mixer]::LastNote } }
        }
      }
    }
    if ($cmd -in 'toggle', 'play', 'pause', 'next', 'prev') { Start-Sleep -Milliseconds 250 }
    Status
  } catch {
    Send @{ error = $_.Exception.Message }
  }
}
