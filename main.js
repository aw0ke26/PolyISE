// POLY//ISE main process: window, file I/O, running code, servers, music.
const { app, BrowserWindow, ipcMain, dialog, shell, screen, powerSaveBlocker } = require('electron');
const fs = require('fs');
const { execFileSync, execFile } = require('child_process');
const path = require('path');
const { paths, readJson, writeJson } = require('./src/main/paths');
const { loadProfiles, loadLibrary, profileForFile } = require('./src/main/profiles');
const { Runner } = require('./src/main/runner');
const { ServerManager } = require('./src/main/servers');
const { Media } = require('./src/main/media');
const { Sandbox, available: sandboxAvailable } = require('./src/main/sandbox');

const config = readJson(paths.config, { defaults: {} });
const settings = { ...config.defaults, ...readJson(paths.settings, {}) };
const profiles = loadProfiles();

let win = null;
const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };

const runner = new Runner(send);
const servers = new ServerManager({ profiles, settings, config, send, env: () => runner.env() });
const media = new Media(send);
const sandbox = new Sandbox(send);

// Learning (default every launch): scripts run in Windows Sandbox and can't change this PC.
// Live: scripts run for real; switching needs a Windows UAC approval, and lasts until the app closes.
let mode = 'learning';
const modeInfo = () => ({ mode, sandbox: sandboxAvailable(), sandboxState: sandbox.state });

// Ask Windows for elevation with a harmless no-op. Resolves true only if the UAC prompt
// was approved (with admin credentials for non-admin users).
function uacConfirm() {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "try { Start-Process -FilePath cmd.exe -ArgumentList '/c','exit 0' -Verb RunAs -Wait -WindowStyle Hidden -ErrorAction Stop; exit 0 } catch { exit 1 }"],
      { windowsHide: true }, (err) => resolve(!err));
  });
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1440, width), height: Math.min(900, height),
    minWidth: 980, minHeight: 640,
    frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    title: 'POLY//ISE',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // Don't let the window close mid-install: a half-unpacked runtime is worse than waiting.
  win.on('close', (e) => {
    if (!servers.installing) return;
    e.preventDefault();
    dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Keep installing'], title: 'Setup is running',
      message: 'Setup is still installing.',
      detail: 'Closing now could leave a half-installed runtime. POLY-ISE will be ready to close when the install finishes.'
    });
  });
}

function saveSettings() { writeJson(paths.settings, settings); }

// ---------- IPC ----------
ipcMain.handle('app:init', async () => {
  await servers.refreshRemoteCatalog();
  const out = {};
  const custom = readJson(paths.customLibrary, {});
  for (const p of Object.values(profiles)) out[p.id] = { ...p, libraryItems: loadLibrary(p), customItems: custom[p.id] || [] };
  return {
    profiles: out, settings, status: servers.status(),
    catalogRepo: config.catalogRepo, scratch: paths.scratch, mediaAvailable: media.available()
  };
});

// Commands the user adds to a language's library, stored outside the install folder.
ipcMain.handle('library:saveCustom', (_e, { langId, items }) => {
  const all = readJson(paths.customLibrary, {});
  all[langId] = (items || []).map((i) => ({ name: String(i.name).slice(0, 80), desc: String(i.desc || '').slice(0, 160), cat: String(i.cat || 'My commands').slice(0, 30), snippet: String(i.snippet) }));
  fs.writeFileSync(paths.customLibrary, JSON.stringify(all, null, 2));
  return all[langId];
});

ipcMain.handle('file:open', async () => {
  const filters = [{ name: 'Scripts', extensions: [...new Set(Object.values(profiles).flatMap((p) => p.extensions.map((e) => e.slice(1))))] }, { name: 'All files', extensions: ['*'] }];
  const res = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters });
  if (res.canceled) return [];
  return res.filePaths.map((f) => {
    const p = profileForFile(profiles, f);
    return { path: f, content: fs.readFileSync(f, 'utf8'), langId: p ? p.id : null };
  });
});

ipcMain.handle('file:save', async (_e, { filePath, content, langId, saveAs }) => {
  let target = filePath && !filePath.startsWith(paths.scratch) && !saveAs ? filePath : null;
  if (!target) {
    const p = profiles[langId];
    const res = await dialog.showSaveDialog(win, {
      defaultPath: filePath ? path.basename(filePath) : `script${p ? p.extensions[0] : '.txt'}`,
      filters: p ? [{ name: p.name, extensions: p.extensions.map((e) => e.slice(1)) }] : []
    });
    if (res.canceled) return null;
    target = res.filePath;
  }
  fs.writeFileSync(target, content, 'utf8');
  return target;
});

ipcMain.handle('run:file', async (_e, { langId, filePath, content, tabId }) => {
  const p = profiles[langId];
  if (!p) return;
  let file = filePath;
  if (!file || file.startsWith(paths.scratch)) {
    file = path.join(paths.scratch, `${tabId}${p.extensions[0]}`);
  }
  fs.writeFileSync(file, content, 'utf8'); // ISE behaviour: run what's in the editor
  if (mode === 'learning') sandbox.run(p, file, tabId); else runner.run(p, file, tabId);
});

ipcMain.handle('run:selection', (_e, { langId, code, tabId }) => {
  const p = profiles[langId];
  if (!p) return;
  if (mode === 'learning') {
    // No persistent session inside the sandbox: run the selection as its own script.
    const file = path.join(paths.scratch, `selection-${tabId}${p.extensions[0]}`);
    fs.writeFileSync(file, code, 'utf8');
    sandbox.run(p, file, tabId);
  } else runner.runSelection(p, code);
});
ipcMain.handle('run:stop', (_e, tabId) => { sandbox.stop(tabId || null); runner.stop(tabId || null); });
ipcMain.handle('console:input', (_e, { langId, line }) => {
  if (mode === 'learning') { send('console:data', { stream: 'sys', text: 'The live session is off in Learning mode. Put the command in the editor and press F5 to run it in the sandbox.\n' }); return; }
  if (profiles[langId]) runner.input(profiles[langId], line);
});
ipcMain.handle('mode:get', () => modeInfo());
ipcMain.handle('sandbox:reset', () => sandbox.reset());
ipcMain.handle('mode:set', async (_e, want) => {
  if (want === mode) return modeInfo();
  if (want === 'live') {
    if (!(await uacConfirm())) { send('console:data', { stream: 'sys', text: 'Live mode not approved; staying in Learning.\n' }); return modeInfo(); }
    mode = 'live';
    sandbox.shutdown(); // free its memory while Live
    send('console:data', { stream: 'sys', text: 'LIVE mode: scripts now run on this PC for real.\n' });
  } else {
    mode = 'learning';
    runner.stop(null, true);
    Object.keys(runner.sessions).forEach((id) => runner.resetSession(id));
    send('console:data', { stream: 'sys', text: 'LEARNING mode: scripts run in a disposable, offline Windows Sandbox.\n' });
    if (sandboxAvailable()) sandbox.ensure();
  }
  return modeInfo();
});
// One-time setup: turn on the Windows Sandbox feature (needs admin + a restart).
ipcMain.handle('sandbox:enable', () => new Promise((resolve) => {
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "try { Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-Command','Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All -NoRestart' -Verb RunAs -Wait -ErrorAction Stop; exit 0 } catch { exit 1 }"],
    { windowsHide: true }, (err) => resolve(!err));
}));
ipcMain.handle('session:reset', (_e, langId) => runner.resetSession(langId));

ipcMain.handle('servers:status', () => servers.status());
ipcMain.handle('setup:list', () => servers.setupList());
ipcMain.handle('setup:run', async (_e, ids) => {
  const blocker = powerSaveBlocker.start('prevent-app-suspension'); // keep the PC from sleeping mid-download
  let res;
  try { res = await servers.setupRun(ids); } finally { powerSaveBlocker.stop(blocker); }
  settings.setupDone = true;
  saveSettings();
  return res;
});
const wrap = (fn) => async (_e, id) => {
  try { await fn(id); return { ok: true }; } catch (err) { send('console:data', { stream: 'err', text: err.message + '\n' }); return { ok: false, error: err.message }; }
};
ipcMain.handle('servers:installServer', wrap((id) => servers.installServer(id)));
ipcMain.handle('servers:uninstallServer', wrap((id) => servers.uninstallServer(id)));
ipcMain.handle('servers:installRuntime', wrap((id) => servers.installRuntime(id)));

ipcMain.handle('settings:set', (_e, partial) => {
  Object.assign(settings, partial);
  saveSettings();
  servers.applySettings();
  return settings;
});

ipcMain.on('lsp:open', (_e, { uri, langId, text }) => servers.docOpen(uri, langId, text));
ipcMain.on('lsp:change', (_e, { uri, text }) => servers.docChange(uri, text));
ipcMain.on('lsp:close', (_e, { uri }) => servers.docClose(uri));
ipcMain.handle('lsp:request', (_e, { langId, method, params }) => servers.request(langId, method, params));

ipcMain.on('media:cmd', (_e, line) => media.cmd(String(line).slice(0, 100)));

ipcMain.on('win:minimize', () => win.minimize());
ipcMain.on('win:maximize', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
ipcMain.on('win:close', () => win.close());
ipcMain.on('win:resize', (_e, { width, height }) => {
  const b = win.getBounds();
  win.setBounds({ x: b.x, y: b.y, width: Math.max(980, Math.round(width)), height: Math.max(640, Math.round(height)) });
});
ipcMain.handle('win:size', () => win.getBounds());

ipcMain.on('open:external', (_e, url) => {
  if (/^https:\/\//.test(url)) shell.openExternal(url);
});

// ---------- lifecycle ----------
// Only one POLY-ISE at a time: a second launch focuses the existing window instead of
// starting another copy that would fight over the same servers and settings.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

app.whenReady().then(() => {
  if (!gotLock) return;
  createWindow();
  if (settings.autoServers) servers.applySettings();
  // Warm up the Learning sandbox in the background so the first run is quick.
  if (mode === 'learning' && sandboxAvailable()) setTimeout(() => sandbox.ensure(), 3000);
});

// Shut down every child process (language servers, sessions, music helper) and their
// children before exiting, so nothing keeps running from the install folder. Leftovers
// block the next update ("POLY-ISE cannot be closed").
let cleanedUp = false;
function killAllChildren() {
  if (cleanedUp) return;
  cleanedUp = true;
  try { sandbox.shutdown(); } catch { /* ignore */ }
  const pids = [
    ...[...runner.runs.values()].map((p) => p && p.pid),
    ...Object.values(runner.sessions).map((p) => p && p.pid),
    ...Object.values(servers.conns).map((c) => c && c.proc && c.proc.pid),
    media.proc && media.proc.pid
  ].filter(Boolean);
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
      else process.kill(pid, 'SIGKILL');
    } catch { /* already gone */ }
  }
  // .NET keeps build servers alive for minutes after `dotnet run`; stop the bundled ones.
  const dotnet = path.join(paths.runtimes, 'dotnet', 'dotnet.exe');
  if (fs.existsSync(dotnet)) {
    try { execFileSync(dotnet, ['build-server', 'shutdown'], { stdio: 'ignore', windowsHide: true, timeout: 15000, env: runner.env() }); } catch { /* ignore */ }
  }
}

app.on('before-quit', killAllChildren);
app.on('will-quit', killAllChildren);
process.on('exit', killAllChildren);

app.on('window-all-closed', () => app.quit());
