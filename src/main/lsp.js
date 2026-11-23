// Minimal Language Server Protocol client: JSON-RPC over a server's stdin/stdout.
// Each message is framed as "Content-Length: N\r\n\r\n<json>".
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { pathToFileURL } = require('url');

class LspConnection extends EventEmitter {
  constructor(id, cmdLine, cwd, env) {
    super();
    this.id = id;
    this.cmdLine = cmdLine;
    this.cwd = cwd;
    this.env = env;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.ready = false;
    this.capabilities = {};
  }

  start(rootPath) {
    this.proc = spawn(this.cmdLine, { cwd: this.cwd, shell: true, windowsHide: true, env: this.env });
    this.proc.stdout.on('data', (chunk) => this.onData(chunk));
    this.proc.stderr.on('data', (d) => this.emit('log', d.toString()));
    this.proc.on('error', (e) => this.emit('log', `spawn error: ${e.message}`));
    this.proc.on('close', (code) => {
      this.ready = false;
      for (const { reject } of this.pending.values()) reject(new Error('server exited'));
      this.pending.clear();
      this.emit('exit', code);
    });
    const rootUri = pathToFileURL(rootPath).href;
    return this.request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'POLY//ISE', version: '0.1.0' },
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: 'workspace' }],
      capabilities: {
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'] } },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'] } },
          publishDiagnostics: { relatedInformation: false }
        },
        workspace: { workspaceFolders: true, configuration: true }
      }
    }, 60000).then((res) => {
      this.capabilities = (res && res.capabilities) || {};
      this.notify('initialized', {});
      this.ready = true;
      this.emit('ready');
      return res;
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.slice(0, headerEnd).toString('ascii');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { this.buffer = this.buffer.slice(headerEnd + 4); continue; }
      const len = parseInt(m[1], 10);
      const start = headerEnd + 4;
      if (this.buffer.length < start + len) return;
      const body = this.buffer.slice(start, start + len).toString('utf8');
      this.buffer = this.buffer.slice(start + len);
      let msg;
      try { msg = JSON.parse(body); } catch { continue; }
      this.dispatch(msg);
    }
  }

  dispatch(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
      return;
    }
    if (msg.method && msg.id !== undefined) {
      // Server -> client requests. Answer the common ones so servers don't stall.
      let result = null;
      if (msg.method === 'workspace/configuration') result = (msg.params.items || []).map(() => ({}));
      if (msg.method === 'workspace/workspaceFolders') result = [];
      this.write({ jsonrpc: '2.0', id: msg.id, result });
      return;
    }
    if (msg.method) this.emit('notification', msg.method, msg.params);
  }

  write(obj) {
    if (!this.proc || this.proc.exitCode !== null) return;
    const json = JSON.stringify(obj);
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
  }

  request(method, params, timeoutMs = 15000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) { this.write({ jsonrpc: '2.0', method, params }); }

  async stop() {
    if (!this.proc || this.proc.exitCode !== null) return;
    try { await this.request('shutdown', null, 3000); this.notify('exit', null); } catch { /* ignore */ }
    setTimeout(() => { if (this.proc.exitCode === null) this.proc.kill(); }, 1500);
  }
}

module.exports = { LspConnection };
