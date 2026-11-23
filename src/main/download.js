// Download a file with progress, then verify its SHA-256 before anything runs it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

async function download(url, dest, onProgress) {
  if (!/^https:\/\//.test(url)) throw new Error(`Refusing non-HTTPS download: ${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'POLY-ISE' } });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const file = fs.createWriteStream(dest);
  const hash = crypto.createHash('sha256');
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
    got += value.length;
    if (!file.write(Buffer.from(value))) await new Promise((r) => file.once('drain', r));
    if (onProgress) onProgress(total ? Math.min(1, got / total) : null, got);
  }
  await new Promise((r) => file.end(r));
  return hash.digest('hex');
}

// Policy:
//  - a published/pinned hash exists  -> must match exactly
//  - no hash, entry.trust === 'https' -> allowed (vendor serves it only over HTTPS, e.g. python.org)
//  - no hash otherwise                -> refused unless allowUnhashed (config.json, for development)
function verify(actual, expected, { trust, allowUnhashed, label }) {
  if (expected) {
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`${label}: SHA-256 mismatch. Expected ${expected}, got ${actual}. The file was deleted.`);
    }
    return 'verified';
  }
  if (trust === 'https' || allowUnhashed) return 'https-only';
  throw new Error(`${label}: no published SHA-256 for this file, so it was not installed. Computed hash: ${actual}.`);
}

// Windows' built-in tar.exe (bsdtar) unpacks zips far faster than Expand-Archive, which can
// take many minutes on archives with thousands of files (like Node.js). Falls back to .NET's
// ZipFile, then to Expand-Archive.
function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 1 << 26 }, (err, _o, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
  });
}

async function expandZip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  if (fs.existsSync(tar)) {
    try { await run(tar, ['-xf', zip, '-C', dest]); return; } catch { /* fall through */ }
  }
  const q = (s) => s.replace(/'/g, "''");
  try {
    await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory('${q(zip)}', '${q(dest)}')`]);
    return;
  } catch { /* fall through */ }
  await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `$ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath '${q(zip)}' -DestinationPath '${q(dest)}' -Force`]);
}

module.exports = { download, verify, expandZip };
