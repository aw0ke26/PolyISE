// Server Manager: installs language servers/runtimes from the catalog, and starts or
// stops servers automatically based on which language tabs are open.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { paths, readJson, writeJson, fill } = require('./paths');
const { findRuntime, clearRuntimeCache } = require('./profiles');
const { LspConnection } = require('./lsp');
const { download, verify, expandZip } = require('./download');
const { resolve } = require('./resolve');

class ServerManager {
  constructor({ profiles, settings, config, send, env }) {
    this.profiles = profiles;
    this.settings = settings;   // live object; saved by main.js
    this.config = config;
    this.send = send;
    this.env = env;             // () => process env with runtimes on PATH
    this.catalog = readJson(paths.catalog, { servers: {}, runtimes: {} });
    this.conns = {};            // langId -> LspConnection
    this.docs = new Map();      // uri -> { langId, text, version }
    this.openCount = {};        // langId -> number of open tabs
    this.idleTimers = {};
    this.busy = {};             // id -> progress 0..1
  }

  async refreshRemoteCatalog() {
    if (!this.config.catalogUrl) return;
    try {
      const res = await fetch(this.config.catalogUrl);
      if (!res.ok) return;
      const remote = await res.json();
      this.catalog = {
        servers: { ...this.catalog.servers, ...(remote.servers || {}) },
        runtimes: { ...this.catalog.runtimes, ...(remote.runtimes || {}) }
      };
    } catch { /* offline is fine: keep the local catalog */ }
  }

  // ---------- status ----------
  serverEntry(p) { return p.lsp && p.lsp.catalog ? this.catalog.servers[p.lsp.catalog] : null; }
  serverDir(p) { return path.join(paths.servers, p.lsp.catalog); }
  serverInstalled(p) {
    if (!p.lsp) return true; // built into the editor
    return fs.existsSync(path.join(this.serverDir(p), '.installed.json'));
  }

  status() {
    return Object.values(this.profiles).map((p) => {
      const rt = findRuntime(p);
      const rtEntry = p.runtime && p.runtime.catalog ? this.catalog.runtimes[p.runtime.catalog] : null;
      const conn = this.conns[p.id];
      return {
        id: p.id, name: p.name, short: p.short, orb: p.orb, bundled: !!p.bundled,
        serverName: p.lsp ? p.lsp.name : 'Built into editor',
        serverBuiltIn: !p.lsp,
        serverInstalled: this.serverInstalled(p),
        serverRunning: !!(conn && conn.ready),
        serverStarting: !!(conn && !conn.ready),
        serverBusy: this.busy['server:' + p.id],
        runtimeFound: rt.found, runtimeSource: rt.source, runtimeName: p.runtime ? p.runtime.label : 'built-in',
        runtimeDownload: !!(rtEntry && rtEntry.type !== 'external'),
        runtimeExternal: rtEntry && rtEntry.type === 'external' ? rtEntry.url : null,
        runtimeBusy: this.busy['runtime:' + p.id],
        pinned: (this.settings.pinned || []).includes(p.id),
        openTabs: this.openCount[p.id] || 0
      };
    });
  }

  pushStatus() { this.send('servers:status', this.status()); }

  // Progress fires on every download chunk; only push to the UI ~8x per second.
  // value: null (finished) or { phase: 'start'|'download'|'unpack'|'install', pct (0..1 or null), bytes }
  progress(key, value) {
    const prev = this.busy[key];
    if (value === null) delete this.busy[key]; else this.busy[key] = value;
    const now = Date.now();
    const phaseChanged = !prev || !value || prev.phase !== value.phase;
    if (phaseChanged || now - (this.lastPush || 0) > 120) {
      this.lastPush = now;
      this.pushStatus();
    } else if (!this.pushTimer) {
      this.pushTimer = setTimeout(() => { this.pushTimer = null; this.lastPush = Date.now(); this.pushStatus(); }, 120);
    }
  }

  // ---------- installs ----------
  runCmd(cmdLine, extraEnv = {}) {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmdLine, { shell: true, windowsHide: true, env: { ...this.env(), ...extraEnv } });
      let err = '';
      proc.stdout.on('data', (d) => this.send('console:data', { stream: 'sys', text: d.toString() }));
      proc.stderr.on('data', (d) => { err += d.toString(); });
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `exit code ${code}`))));
    });
  }

  async installFromEntry(entry, dir, key, label) {
    const allowUnhashed = !!this.config.allowUnhashedDownloads;
    fs.mkdirSync(dir, { recursive: true });
    let info = { version: entry.version || '' };
    if (entry.type === 'npm') {
      // npm checks each package's integrity hash from the registry itself.
      this.progress(key, { phase: 'install' });
      await this.runCmd(`npm install --prefix "${dir}" --no-audit --no-fund ${entry.packages.join(' ')}`);
      info.verified = 'npm integrity';
    } else if (entry.type === 'go') {
      this.progress(key, { phase: 'install' });
      await this.runCmd(`go install ${entry.package}`, { GOBIN: dir });
      info.verified = 'Go checksum database';
    } else if (entry.type === 'zip' || entry.type === 'sfx') {
      const r = await resolve(entry);
      info = { version: r.version, url: r.url };
      const file = path.join(paths.data, 'downloads', path.basename(new URL(r.url).pathname));
      const actual = await download(r.url, file, (pct, bytes) => this.progress(key, { phase: 'download', pct, bytes }));
      try {
        info.verified = verify(actual, r.sha256, { trust: entry.trust, allowUnhashed, label });
      } catch (e) { fs.rmSync(file, { force: true }); throw e; }
      this.progress(key, { phase: 'unpack' });
      info.sha256 = actual;
      info.hashSource = r.hashSource || 'none (HTTPS only)';
      if (entry.type === 'zip' && entry.stripTop) {
        // Zip has one top folder (e.g. go/ or node-v24-win-x64/): unpack, then lift its contents.
        const tmp = dir + '.tmp';
        fs.rmSync(tmp, { recursive: true, force: true });
        await expandZip(file, tmp);
        const kids = fs.readdirSync(tmp);
        const top = kids.length === 1 ? path.join(tmp, kids[0]) : tmp;
        fs.rmSync(dir, { recursive: true, force: true });
        fs.renameSync(top, dir);
        fs.rmSync(tmp, { recursive: true, force: true });
      } else if (entry.type === 'zip') {
        await expandZip(file, dir);
      } else {
        await this.runCmd(`"${file}" -o"${dir}" -y`);
      }
      fs.rmSync(file, { force: true });
    } else if (entry.type === 'script') {
      // Vendor install scripts (dotnet-install.ps1) are fetched over HTTPS from the vendor
      // and verify their own downloads; they aren't hash-pinned because they change often.
      const file = path.join(paths.data, 'downloads', path.basename(new URL(entry.url).pathname));
      await download(entry.url, file);
      // The vendor script downloads and unpacks by itself and reports no percentage.
      this.progress(key, { phase: 'install' });
      await this.runCmd(`powershell -NoProfile -ExecutionPolicy Bypass -File "${file}" ${fill(entry.args || '', { dir })}`);
      fs.rmSync(file, { force: true });
      info.verified = 'vendor install script';
    } else {
      throw new Error(`${label}: unknown install type "${entry.type}".`);
    }
    if (entry.post === 'python-embed') { this.progress(key, { phase: 'install' }); await this.pythonEmbedPost(dir); }
    writeJson(path.join(dir, '.installed.json'), { ...info, at: new Date().toISOString() });
    this.send('console:data', { stream: 'sys', text: `✓ ${label} ${info.version || ''} installed (${info.verified})\n` });
  }

  // The embeddable Python ignores site-packages until "import site" is enabled; then add pip.
  async pythonEmbedPost(dir) {
    const pth = fs.readdirSync(dir).find((f) => /^python\d+\._pth$/.test(f));
    if (pth) {
      const p = path.join(dir, pth);
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/^#\s*import site/m, 'import site'));
    }
    const getPip = path.join(paths.data, 'downloads', 'get-pip.py');
    await download('https://bootstrap.pypa.io/get-pip.py', getPip);
    await this.runCmd(`"${path.join(dir, 'python.exe')}" "${getPip}" --no-warn-script-location`);
    fs.rmSync(getPip, { force: true });
  }

  async installServer(langId) {
    const p = this.profiles[langId];
    const entry = p && this.serverEntry(p);
    if (!entry) throw new Error('No catalog entry for this server.');
    if (entry.needsRuntime && !findRuntime(p).found) throw new Error(`${p.lsp.name} needs the ${p.runtime.label} runtime first.`);
    if (entry.requires && !findRuntime(this.profiles[entry.requires]).found) {
      throw new Error(`${p.lsp.name} needs Node.js first (it installs with npm).`);
    }
    const key = 'server:' + langId;
    this.progress(key, { phase: 'start' });
    try {
      await this.installFromEntry(entry, this.serverDir(p), key, p.lsp.name);
      if (this.openCount[langId]) this.ensure(langId);
    } finally { this.progress(key, null); }
  }

  async uninstallServer(langId) {
    const p = this.profiles[langId];
    if (!p || !p.lsp) return;
    await this.stopServer(langId);
    fs.rmSync(this.serverDir(p), { recursive: true, force: true });
    this.pushStatus();
  }

  async installRuntime(langId) {
    const p = this.profiles[langId];
    const entry = p && p.runtime && this.catalog.runtimes[p.runtime.catalog];
    if (!entry || entry.type === 'external') throw new Error('This runtime must be installed with its official installer.');
    const key = 'runtime:' + langId;
    this.progress(key, { phase: 'start' });
    try {
      await this.installFromEntry(entry, path.join(paths.runtimes, p.runtime.catalog), key, p.runtime.label);
    } finally { clearRuntimeCache(); this.progress(key, null); }
  }

  // ---------- first-run setup ----------
  setupList() {
    return (this.catalog.setup || []).map((item) => {
      const p = this.profiles[item.lang];
      let installed = false;
      if (item.kind === 'runtime') installed = !!(p && findRuntime(p).found);
      if (item.kind === 'server') installed = !!(p && p.lsp && this.serverInstalled(p));
      return { ...item, installed };
    });
  }

  get installing() { return Object.keys(this.busy).length > 0 || !!this.setupRunning; }

  async setupRun(ids) {
    this.setupRunning = true;
    try { return await this.setupRunInner(ids); } finally { this.setupRunning = false; }
  }

  async setupRunInner(ids) {
    const items = this.setupList().filter((i) => ids.includes(i.id));
    const results = [];
    for (const item of items) {
      this.send('setup:progress', { id: item.id, state: 'working' });
      try {
        if (item.kind === 'runtime') await this.installRuntime(item.lang);
        else await this.installServer(item.lang);
        this.send('setup:progress', { id: item.id, state: 'done' });
        results.push({ id: item.id, ok: true });
      } catch (e) {
        this.send('setup:progress', { id: item.id, state: 'failed', error: e.message });
        this.send('console:data', { stream: 'err', text: `${item.label}: ${e.message}\n` });
        results.push({ id: item.id, ok: false, error: e.message });
      }
    }
    this.pushStatus();
    return results;
  }

  // ---------- automatic start / stop ----------
  ensure(langId) {
    clearTimeout(this.idleTimers[langId]);
    const p = this.profiles[langId];
    if (!p || !p.lsp || this.conns[langId] || !this.serverInstalled(p)) return;
    const entry = this.serverEntry(p);
    if (!entry || !entry.launch) return;
    const rt = findRuntime(p);
    const vars = { dir: this.serverDir(p), root: paths.root, logs: paths.logs, runtime: rt.path ? `"${rt.path}"` : '' };
    // launch is a command, or a list of { if: <file that must exist>, cmd } tried in order
    // (release layouts change between versions, e.g. OmniSharp.exe vs OmniSharp.dll).
    let launch = entry.launch;
    if (Array.isArray(launch)) {
      const hit = launch.find((l) => !l.if || fs.existsSync(fill(l.if, vars)));
      if (!hit) {
        this.send('console:data', { stream: 'err', text: `${p.lsp.name}: installed files don't match any known layout. Reinstall it from Servers.\n` });
        return;
      }
      launch = hit.cmd;
    }
    const cmd = fill(launch, vars);
    const conn = new LspConnection(langId, cmd, paths.scratch, { ...this.env(), ...(entry.env || {}) });
    this.conns[langId] = conn;
    const logFile = path.join(paths.logs, `lsp-${langId}.log`);
    conn.on('log', (t) => fs.appendFile(logFile, t, () => {}));
    conn.on('notification', (method, params) => {
      if (method === 'textDocument/publishDiagnostics') this.send('lsp:diagnostics', params);
    });
    conn.on('exit', () => { delete this.conns[langId]; this.pushStatus(); });
    this.pushStatus();
    conn.start(paths.scratch).then(() => {
      for (const [uri, d] of this.docs) {
        if (d.langId === langId) conn.notify('textDocument/didOpen', { textDocument: { uri, languageId: p.lsp.languageId || p.monaco, version: d.version, text: d.text } });
      }
      this.pushStatus();
    }).catch((e) => {
      fs.appendFile(logFile, `init failed: ${e.message}\n`, () => {});
      this.send('console:data', { stream: 'err', text: `${p.lsp.name} failed to start (see data/logs/lsp-${langId}.log)\n` });
      this.stopServer(langId);
    });
  }

  keepAlive(langId) {
    return this.settings.multiServer && (this.settings.pinned || []).includes(langId);
  }

  scheduleIdle(langId) {
    clearTimeout(this.idleTimers[langId]);
    if (this.keepAlive(langId)) return;
    const secs = Number(this.settings.idleSeconds) || 60;
    this.idleTimers[langId] = setTimeout(() => {
      if (!this.openCount[langId] && !this.keepAlive(langId)) this.stopServer(langId);
    }, secs * 1000);
  }

  async stopServer(langId) {
    clearTimeout(this.idleTimers[langId]);
    const c = this.conns[langId];
    delete this.conns[langId];
    if (c) await c.stop();
    this.pushStatus();
  }

  applySettings() {
    for (const id of Object.keys(this.profiles)) {
      if (this.keepAlive(id) && this.settings.autoServers) this.ensure(id);
      else if (!this.openCount[id] && this.conns[id]) this.scheduleIdle(id);
    }
    this.pushStatus();
  }

  // ---------- documents (called by the renderer for each tab) ----------
  docOpen(uri, langId, text) {
    this.docs.set(uri, { langId, text, version: 1 });
    this.openCount[langId] = (this.openCount[langId] || 0) + 1;
    if (this.settings.autoServers) this.ensure(langId);
    const c = this.conns[langId];
    const p = this.profiles[langId];
    if (c && c.ready && p && p.lsp) c.notify('textDocument/didOpen', { textDocument: { uri, languageId: p.lsp.languageId || p.monaco, version: 1, text } });
    this.pushStatus();
  }

  docChange(uri, text) {
    const d = this.docs.get(uri);
    if (!d) return;
    d.text = text; d.version += 1;
    const c = this.conns[d.langId];
    if (c && c.ready) c.notify('textDocument/didChange', { textDocument: { uri, version: d.version }, contentChanges: [{ text }] });
  }

  docClose(uri) {
    const d = this.docs.get(uri);
    if (!d) return;
    this.docs.delete(uri);
    const c = this.conns[d.langId];
    if (c && c.ready) c.notify('textDocument/didClose', { textDocument: { uri } });
    this.openCount[d.langId] = Math.max(0, (this.openCount[d.langId] || 1) - 1);
    if (!this.openCount[d.langId] && this.settings.autoServers) this.scheduleIdle(d.langId);
    this.pushStatus();
  }

  async request(langId, method, params) {
    const c = this.conns[langId];
    if (!c || !c.ready) return null;
    try { return await c.request(method, params, 8000); } catch { return null; }
  }

  async dispose() { await Promise.all(Object.keys(this.conns).map((id) => this.stopServer(id))); }
}

ServerManager.fileUri = (file) => pathToFileURL(file).href;
module.exports = { ServerManager };
