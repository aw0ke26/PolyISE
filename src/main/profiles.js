// Loads language profiles (languages/*.json) and finds each language's runtime.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { paths, readJson } = require('./paths');

function loadProfiles() {
  const out = {};
  for (const f of fs.readdirSync(paths.languages)) {
    if (!f.endsWith('.json')) continue;
    const p = readJson(path.join(paths.languages, f), null);
    if (p && p.id) out[p.id] = p;
  }
  return out;
}

function loadLibrary(profile) {
  if (!profile.library) return [];
  return readJson(path.join(paths.root, profile.library), []);
}

// Every match for an executable on PATH (Windows `where`, else `which -a`).
function onPathAll(name) {
  try {
    const win = process.platform === 'win32';
    const res = execFileSync(win ? 'where' : 'which', win ? [name] : ['-a', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return res.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}
function onPath(name) { return onPathAll(name)[0] || null; }

// Make sure a found executable really runs. Windows ships fake python.exe/python3.exe
// "App Execution Alias" stubs that only open the Microsoft Store (exit code 9009).
function works(exe, args) {
  if (!args) return true;
  try {
    execFileSync(exe, args, { stdio: 'ignore', windowsHide: true, timeout: 8000 });
    return true;
  } catch { return false; }
}

// Runtime lookups shell out to `where`, which blocks; cache them so status updates stay cheap.
const rtCache = new Map();
function clearRuntimeCache() { rtCache.clear(); }

// Returns { found, path, source: 'bundled' | 'downloaded' | 'system' | null }
function findRuntime(profile) {
  if (!profile) return { found: false, path: null, source: null };
  if (rtCache.has(profile.id)) return rtCache.get(profile.id);
  const res = findRuntimeUncached(profile);
  rtCache.set(profile.id, res);
  return res;
}

function findRuntimeUncached(profile) {
  const rt = profile.runtime;
  if (!rt) return { found: true, path: null, source: 'builtin' };
  for (const rel of rt.local || []) {
    const abs = path.join(rel.startsWith('runtimes') ? paths.store : paths.root, rel);
    if (fs.existsSync(abs)) {
      return { found: true, path: abs, source: rel.startsWith('runtimes') && rt.bundled ? 'bundled' : 'downloaded' };
    }
  }
  for (const name of rt.probe || []) {
    for (const p of onPathAll(name)) {
      if (works(p, rt.verify)) return { found: true, path: p, source: 'system' };
    }
  }
  return { found: false, path: null, source: null };
}

function profileForFile(profiles, file) {
  const ext = path.extname(file).toLowerCase();
  return Object.values(profiles).find((p) => (p.extensions || []).includes(ext)) || null;
}

module.exports = { loadProfiles, loadLibrary, findRuntime, clearRuntimeCache, profileForFile, onPath };
