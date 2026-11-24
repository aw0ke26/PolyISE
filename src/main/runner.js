// Runs scripts (F5) and keeps an ISE-style persistent session per language for
// Run Selection (F8), so variables survive between runs like PowerShell ISE.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { paths, fill } = require('./paths');
const { findRuntime } = require('./profiles');

function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    proc.kill('SIGKILL');
  }
}

class Runner {
  constructor(send) {
    this.send = send;          // (channel, payload) => void, goes to the renderer
    this.runs = new Map();     // tabId -> running F5 process (each tab can run at once)
    this.sessions = {};        // langId -> persistent REPL process
  }

  vars(profile, file) {
    const rt = findRuntime(profile);
    const base = path.join(paths.scratch, 'polyise-build');
    return {
      runtime: rt.path ? `"${rt.path}"` : (profile.runtime && profile.runtime.probe ? profile.runtime.probe[0] : ''),
      runtimeRaw: rt.path || '',
      file,
      dir: path.dirname(file),
      out: base + (process.platform === 'win32' ? '.exe' : ''),
      root: paths.root
    };
  }

  out(stream, text, tabId) { this.send('console:data', { stream, text, tabId }); }

  // Run each step in order; stop at the first failure. Each tab runs independently.
  async run(profile, file, tabId) {
    this.stop(tabId, true);
    if (!profile.run) { this.out('err', `${profile.name} has no run command.\n`, tabId); return; }
    const rt = findRuntime(profile);
    if (!rt.found) {
      this.out('err', `${profile.name} runtime not found. Open Servers to download it.\n`, tabId);
      return;
    }
    const v = this.vars(profile, file);
    this.out('sys', `▶ ${path.basename(file)}\n`, tabId);
    this.send('run:state', { tabId, running: true });
    const started = Date.now();
    let code = 0;
    for (const step of profile.run) {
      code = await this.exec(fill(step, v), path.dirname(file), tabId);
      if (code !== 0 || !this.runs.has(tabId)) break;
    }
    const stopped = !this.runs.has(tabId);
    this.runs.delete(tabId);
    this.send('run:state', { tabId, running: false });
    if (stopped) return;
    if (code !== 0) this.out('sys', `■ exited with code ${code}\n`, tabId);
    else this.out('sys', `■ done in ${((Date.now() - started) / 1000).toFixed(2)}s\n`, tabId);
    this.send('console:done', { code, tabId });
  }

  exec(cmdLine, cwd, tabId) {
    return new Promise((resolve) => {
      const proc = spawn(cmdLine, { cwd, shell: true, windowsHide: true, env: this.env() });
      this.runs.set(tabId, proc);
      proc.stdout.on('data', (d) => this.out('out', d.toString(), tabId));
      proc.stderr.on('data', (d) => this.out('err', d.toString(), tabId));
      proc.on('error', (e) => { this.out('err', e.message + '\n', tabId); resolve(1); });
      proc.on('close', (c) => resolve(c === null ? 1 : c));
    });
  }

  // Put bundled/downloaded runtimes first on PATH so they win over system copies.
  env() {
    const extra = [];
    for (const d of ['python', 'python/Scripts', 'node', 'go/bin', 'git/bin', 'dotnet']) {
      const p = path.join(paths.runtimes, d);
      if (fs.existsSync(p)) extra.push(p);
    }
    const sep = process.platform === 'win32' ? ';' : ':';
    const env = { ...process.env, PATH: extra.concat([process.env.PATH || '']).join(sep), PYTHONIOENCODING: 'utf-8',
      DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1',
      // Don't leave .NET build servers running in the background after a C# run.
      DOTNET_CLI_USE_MSBUILD_SERVER: '0', MSBUILDDISABLENODEREUSE: '1', UseSharedCompilation: 'false',
      // Practice folders: the same variable names Learning mode sets inside the sandbox.
      POLY_DATA: paths.practiceData, POLY_OUTPUT: paths.practiceOutput };
    const dotnet = path.join(paths.runtimes, 'dotnet');
    if (fs.existsSync(dotnet)) { env.DOTNET_ROOT = dotnet; env.DOTNET_CLI_TELEMETRY_OPTOUT = '1'; }
    return env;
  }

  // Force-stop one tab's script (and everything it started), or every tab's.
  stop(tabId, quiet) {
    const ids = tabId ? [tabId] : [...this.runs.keys()];
    for (const id of ids) {
      const p = this.runs.get(id);
      if (!p) continue;
      this.runs.delete(id);
      killTree(p);
      this.send('run:state', { tabId: id, running: false });
      if (!quiet) this.out('sys', '■ force-stopped\n', id);
    }
  }

  // ---- persistent sessions (Run Selection) ----
  session(profile) {
    const existing = this.sessions[profile.id];
    if (existing && existing.exitCode === null) return existing;
    if (!profile.repl) return null;
    const v = this.vars(profile, '');
    const proc = spawn(fill(profile.repl.cmd, v), { cwd: paths.scratch, shell: true, windowsHide: true, env: this.env() });
    proc.stdout.on('data', (d) => this.out('out', d.toString()));
    proc.stderr.on('data', (d) => this.out('err', d.toString()));
    proc.on('close', () => { if (this.sessions[profile.id] === proc) delete this.sessions[profile.id]; });
    this.sessions[profile.id] = proc;
    return proc;
  }

  runSelection(profile, code) {
    if (!profile.repl) {
      this.out('sys', `${profile.name} has no interactive session; use Run (F5).\n`);
      return;
    }
    const rt = findRuntime(profile);
    if (!rt.found) { this.out('err', `${profile.name} runtime not found.\n`); return; }
    const proc = this.session(profile);
    const tmp = path.join(paths.scratch, `selection${profile.extensions[0]}`);
    fs.writeFileSync(tmp, code, 'utf8');
    this.out('sys', `▶ selection (${code.split('\n').length} lines)\n`);
    proc.stdin.write(fill(profile.repl.load, { file: tmp }) + '\n');
  }

  // Type a line straight into the language's session (console input box).
  input(profile, line) {
    const proc = this.session(profile);
    if (!proc) { this.out('sys', `${profile.name} has no interactive session.\n`); return; }
    this.out('in', line + '\n');
    proc.stdin.write(line + '\n');
  }

  resetSession(profileId) {
    const p = this.sessions[profileId];
    if (p) { killTree(p); delete this.sessions[profileId]; this.out('sys', 'session reset\n'); }
  }

  dispose() {
    this.stop(null, true);
    Object.values(this.sessions).forEach(killTree);
  }
}

module.exports = { Runner, killTree };
