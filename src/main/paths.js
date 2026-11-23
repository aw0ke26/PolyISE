// Central place for every folder the app uses. Everything lives next to the app
// (portable), so the whole thing can run from a USB drive.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const root = app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '..', '..');

// Downloads (runtimes, servers) and settings live OUTSIDE the install folder, so updates
// and uninstalls don't delete or trip over hundreds of MB of runtimes.
//   Installed:  %LOCALAPPDATA%\POLY-ISE-Data
//   Portable:   put an empty file named "portable" next to POLY-ISE.exe -> everything stays beside it
//   From source (npm start): the project folder
const portable = !app.isPackaged || fs.existsSync(path.join(root, 'portable'));
const store = portable ? root : path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'POLY-ISE-Data');

const paths = {
  root,
  store,
  languages: path.join(root, 'languages'),
  library: path.join(root, 'library'),
  catalog: path.join(root, 'catalog', 'catalog.json'),
  runtimes: path.join(store, 'runtimes'),
  servers: path.join(store, 'servers'),
  data: path.join(store, 'data'),
  scratch: path.join(store, 'data', 'scratch'),
  logs: path.join(store, 'data', 'logs'),
  settings: path.join(store, 'data', 'settings.json'),
  customLibrary: path.join(store, 'data', 'custom-library.json'), // user-added commands, kept across updates
  config: path.join(root, 'config.json'),
  mediaHelper: path.join(root, 'tools', 'media-helper.ps1')
};

for (const dir of [paths.runtimes, paths.servers, paths.data, paths.scratch, paths.logs]) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

// Fill {placeholders} in a string from a map. Unknown placeholders stay as-is.
function fill(str, vars) {
  return String(str).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
}

module.exports = { paths, readJson, writeJson, fill };
