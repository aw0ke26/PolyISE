// Bridges the music bar to tools/media-helper.ps1, which runs in the Windows PowerShell
// that ships with Windows (no extra installs). One JSON message per line in both directions.
const fs = require('fs');
const { spawn } = require('child_process');
const { paths } = require('./paths');

class Media {
  constructor(send) {
    this.send = send;
    this.proc = null;
    this.buf = '';
  }

  available() { return process.platform === 'win32' && fs.existsSync(paths.mediaHelper); }

  start() {
    if (this.proc || !this.available()) {
      if (!this.available()) this.send('media:state', { available: false });
      return;
    }
    this.proc = spawn('powershell.exe', ['-Mta', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', paths.mediaHelper], { windowsHide: true, env: { ...process.env, POLYISE_PID: String(process.pid) } });
    this.proc.stdout.on('data', (d) => {
      this.buf += d.toString();
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        try { this.send('media:state', { available: true, ...JSON.parse(line) }); } catch { /* ignore */ }
      }
    });
    this.proc.on('close', () => { this.proc = null; });
    this.cmd('status');
  }

  cmd(line) {
    if (!this.proc) this.start();
    if (this.proc) this.proc.stdin.write(line + '\n');
  }

  stop() { if (this.proc) { this.proc.kill(); this.proc = null; } }
}

module.exports = { Media };
