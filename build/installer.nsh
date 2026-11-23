; Before installing/uninstalling, stop POLY-ISE.exe wherever it runs from, plus anything
; still running from the install folder (language servers, .NET build servers, the music
; helper), instead of failing with "POLY-ISE cannot be closed".
!macro customCheckAppRunning
  DetailPrint "Closing POLY-ISE and its background tools..."
  nsExec::ExecToLog 'taskkill.exe /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$d = [IO.Path]::GetFullPath(''$INSTDIR'').TrimEnd(''\'') + ''\''; Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$d, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"'
  Pop $0
  Sleep 1000
!macroend
