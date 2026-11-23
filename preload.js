// Safe, narrow bridge between the UI and the main process.
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (fn) => {
  const handler = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('poly', {
  init: () => ipcRenderer.invoke('app:init'),
  openFiles: () => ipcRenderer.invoke('file:open'),
  saveFile: (args) => ipcRenderer.invoke('file:save', args),
  runFile: (args) => ipcRenderer.invoke('run:file', args),
  runSelection: (args) => ipcRenderer.invoke('run:selection', args),
  stop: (tabId) => ipcRenderer.invoke('run:stop', tabId),
  consoleInput: (args) => ipcRenderer.invoke('console:input', args),
  resetSession: (langId) => ipcRenderer.invoke('session:reset', langId),

  serverStatus: () => ipcRenderer.invoke('servers:status'),
  installServer: (id) => ipcRenderer.invoke('servers:installServer', id),
  uninstallServer: (id) => ipcRenderer.invoke('servers:uninstallServer', id),
  installRuntime: (id) => ipcRenderer.invoke('servers:installRuntime', id),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),
  saveCustomLibrary: (langId, items) => ipcRenderer.invoke('library:saveCustom', { langId, items }),
  setupList: () => ipcRenderer.invoke('setup:list'),
  setupRun: (ids) => ipcRenderer.invoke('setup:run', ids),
  onSetup: listen('setup:progress'),

  lspOpen: (a) => ipcRenderer.send('lsp:open', a),
  lspChange: (a) => ipcRenderer.send('lsp:change', a),
  lspClose: (a) => ipcRenderer.send('lsp:close', a),
  lspRequest: (a) => ipcRenderer.invoke('lsp:request', a),

  media: (line) => ipcRenderer.send('media:cmd', line),
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
    resize: (size) => ipcRenderer.send('win:resize', size),
    size: () => ipcRenderer.invoke('win:size')
  },
  openExternal: (url) => ipcRenderer.send('open:external', url),

  onConsole: listen('console:data'),
  onRunDone: listen('console:done'),
  onRunState: listen('run:state'),
  getMode: () => ipcRenderer.invoke('mode:get'),
  setMode: (m) => ipcRenderer.invoke('mode:set', m),
  enableSandbox: () => ipcRenderer.invoke('sandbox:enable'),
  onSandboxMissing: listen('sandbox:missing'),
  onSandboxState: listen('sandbox:state'),
  resetSandbox: () => ipcRenderer.invoke('sandbox:reset'),
  onServers: listen('servers:status'),
  onDiagnostics: listen('lsp:diagnostics'),
  onMedia: listen('media:state')
});
