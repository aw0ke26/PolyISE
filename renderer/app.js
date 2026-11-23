// POLY//ISE renderer: tabs, modes, Monaco, console, library drag-and-drop,
// Server Manager, music bar.
/* global monaco, require, Sounds, LspBridge */
(async () => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

  const boot = await window.poly.init();
  const profiles = boot.profiles;
  const order = Object.values(profiles).sort((a, b) => (a.order || 99) - (b.order || 99));
  let settings = boot.settings;
  let status = boot.status;

  let modeState = null; // Learning/Live, filled in below
  const state = { tabs: [], active: null, mode: order[0].id, libCat: 'All', libQuery: '', tabSeq: 1 };

  // ---------- skin / accent / sounds ----------
  const SKINS = ['chrome', 'aqua', 'graphite'];
  const SKIN_NAMES = { chrome: 'Chrome', aqua: 'Aqua Ice', graphite: 'Graphite' };
  function applySkin() {
    document.body.dataset.skin = settings.skin || 'chrome';
    document.documentElement.style.setProperty('--accent', settings.accent || '#b8f26b');
    $('stSkin').textContent = 'Skin: ' + SKIN_NAMES[settings.skin || 'chrome'];
    Sounds.enabled = settings.sounds !== false;
  }
  applySkin();
  $('btnSkin').onclick = async () => {
    Sounds.click();
    const next = SKINS[(SKINS.indexOf(settings.skin) + 1) % SKINS.length];
    settings = await window.poly.setSettings({ skin: next });
    applySkin();
  };

  // ---------- Monaco ----------
  await new Promise((resolve) => {
    require.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } });
    require(['vs/editor/editor.main'], resolve);
  });
  monaco.editor.defineTheme('polyise', {
    base: 'vs-dark', inherit: true,
    rules: [
      { token: 'comment', foreground: '7b93ad', fontStyle: 'italic' },
      { token: 'string', foreground: 'b8f26b' },
      { token: 'keyword', foreground: 'ff9ad5' },
      { token: 'number', foreground: 'c9a7ff' },
      { token: 'variable', foreground: '7fd8ff' },
      { token: 'type', foreground: '6ee7c8' },
      { token: 'tag', foreground: 'ff9ad5' },
      { token: 'attribute.name', foreground: 'ffb38a' }
    ],
    colors: { 'editor.background': '#0e1522', 'editor.lineHighlightBackground': '#16223a', 'editorLineNumber.foreground': '#7186a4', 'editorCursor.foreground': '#b8f26b' }
  });
  const editor = monaco.editor.create($('editor'), {
    theme: 'polyise', automaticLayout: true, fontSize: 14, fontFamily: "'Cascadia Code', Consolas, monospace",
    minimap: { enabled: false }, scrollBeyondLastLine: false, smoothScrolling: true, cursorSmoothCaretAnimation: 'on',
    dropIntoEditor: { enabled: false }, renderLineHighlight: 'all', padding: { top: 4 }
  });
  order.forEach((p) => LspBridge.register(p));
  window.poly.onDiagnostics((d) => LspBridge.onDiagnostics(d));

  // ---------- tabs ----------
  const langForPath = (p) => {
    const ext = (p.match(/\.[^.\\/]+$/) || [''])[0].toLowerCase();
    return order.find((x) => x.extensions.includes(ext));
  };
  const monacoLang = (profile, filePath) => {
    const ext = ((filePath || '').match(/\.[^.\\/]+$/) || [''])[0].toLowerCase();
    return (profile.monacoByExt && profile.monacoByExt[ext]) || profile.monaco;
  };
  const basename = (p) => p.split(/[\\/]/).pop();

  function newTab({ langId, filePath, content }) {
    const p = profiles[langId];
    const id = 'tab' + state.tabSeq++;
    const pathForUri = filePath || `${boot.scratch}\\untitled-${id}${p.extensions[0]}`;
    const uri = LspBridge.fileUri(pathForUri);
    const model = monaco.editor.createModel(content !== undefined ? content : (p.template || ''), monacoLang(p, pathForUri), monaco.Uri.parse(uri));
    const tab = { id, langId, filePath: filePath || null, uri, model, dirty: false, title: filePath ? basename(filePath) : `untitled${p.extensions[0]}` };
    let timer = null;
    model.onDidChangeContent(() => {
      if (!tab.dirty) { tab.dirty = true; renderTabs(); }
      clearTimeout(timer);
      timer = setTimeout(() => {
        window.poly.lspChange({ uri: tab.uri, text: model.getValue() });
        if (tab.id === state.active && profiles[tab.langId].mode === 'preview') updatePreview();
      }, 300);
    });
    LspBridge.track(model, uri, langId);
    window.poly.lspOpen({ uri, langId, text: model.getValue() });
    state.tabs.push(tab);
    activate(id);
    return tab;
  }

  function closeTab(id) {
    const i = state.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const t = state.tabs[i];
    if (t.dirty && !confirm(`Close ${t.title} without saving?`)) return;
    if (runningTabs.has(t.id)) window.poly.stop(t.id);
    window.poly.lspClose({ uri: t.uri });
    LspBridge.untrack(t.model, t.uri);
    t.model.dispose();
    state.tabs.splice(i, 1);
    if (state.active === id) {
      const next = state.tabs[i] || state.tabs[i - 1];
      if (next) activate(next.id); else newTab({ langId: state.mode });
    } else renderTabs();
  }

  const activeTab = () => state.tabs.find((t) => t.id === state.active);

  function activate(id) {
    state.active = id;
    const t = activeTab();
    editor.setModel(t.model);
    editor.focus();
    if (state.mode !== t.langId) setMode(t.langId, false);
    renderTabs();
    updatePanels();
  }

  function renderTabs() {
    const box = $('tabs');
    box.textContent = '';
    for (const t of state.tabs) {
      const p = profiles[t.langId];
      const b = el('div', 'tab' + (t.id === state.active ? ' active' : ''));
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(t.id === state.active));
      b.title = t.filePath || t.title;
      const dot = el('span', 'tdot'); dot.style.setProperty('--c', p.orb.color);
      const name = el('span', t.dirty ? 'dirty' : '', t.title);
      const x = el('button', 'tab-x', '×'); x.setAttribute('aria-label', `Close ${t.title}`);
      x.onclick = (e) => { e.stopPropagation(); Sounds.click(); closeTab(t.id); };
      if (runningTabs.has(t.id)) {
        b.classList.add('running');
        const stop = el('button', 'tab-stop', '■');
        stop.title = 'Force stop this script';
        stop.setAttribute('aria-label', `Force stop ${t.title}`);
        stop.onclick = (e) => { e.stopPropagation(); Sounds.click(); window.poly.stop(t.id); };
        b.append(dot, name, stop, x);
      } else b.append(dot, name, x);
      b.onclick = () => { Sounds.click(); activate(t.id); };
      box.append(b);
    }
    const plus = el('button', 'tab-new', '+'); plus.setAttribute('aria-label', 'New tab');
    plus.onclick = () => { Sounds.click(); newTab({ langId: state.mode }); };
    box.append(plus);
  }

  // ---------- modes ----------
  function renderOrbs() {
    const box = $('orbs');
    box.textContent = '';
    for (const p of order) {
      const s = status.find((x) => x.id === p.id);
      const b = el('button', 'orb' + (p.id === state.mode ? ' selected' : '') + (s && !s.runtimeFound ? ' missing' : ''), p.short);
      b.style.setProperty('--c', p.orb.color); b.style.setProperty('--d', p.orb.dark); b.style.setProperty('--t', p.orb.text);
      b.setAttribute('aria-label', `${p.name} mode${s && !s.runtimeFound ? ' (runtime not found)' : ''}`);
      b.title = s && !s.runtimeFound ? `${p.name}: runtime not found. Open Servers to get it.` : p.name;
      b.onclick = () => { Sounds.whoosh(); setMode(p.id, true); };
      box.append(b);
    }
  }

  // switchTab: also jump to (or create) a tab of that language, like picking a mode in ISE
  function setMode(langId, switchTab) {
    state.mode = langId;
    state.libCat = 'All';
    const pod = $('pod'); pod.classList.remove('shine'); void pod.offsetWidth; pod.classList.add('shine');
    typeLcd(`MODE ▸ ${profiles[langId].short === '<>' ? 'HTML' : profiles[langId].name.toUpperCase().replace('JAVASCRIPT / TYPESCRIPT', 'JS / TS')}`);
    if (switchTab) {
      const t = activeTab();
      if (!t || t.langId !== langId) {
        const existing = state.tabs.find((x) => x.langId === langId);
        if (existing) activate(existing.id); else newTab({ langId });
      }
    }
    renderOrbs(); renderLibrary(); updatePanels();
  }

  let lcdTimer = null;
  function typeLcd(text) {
    clearInterval(lcdTimer);
    let i = 0;
    $('lcdMode').textContent = '';
    lcdTimer = setInterval(() => { $('lcdMode').textContent = text.slice(0, ++i); if (i >= text.length) clearInterval(lcdTimer); }, 22);
  }

  function updatePanels() {
    const p = profiles[state.mode];
    const s = status.find((x) => x.id === state.mode) || {};
    const preview = p.mode === 'preview';
    $('consolePane').hidden = preview;
    $('previewPane').hidden = !preview;
    $('runLabel').textContent = preview ? 'Preview' : 'Run';
    $('btnRunSel').disabled = preview || !p.repl;
    $('btnResetSession').disabled = !p.repl;
    $('consoleTitle').textContent = `CONSOLE · ${p.name}`;
    $('consolePrompt').textContent = p.repl ? `${p.short}>` : '—';
    $('consoleInput').disabled = !p.repl;
    $('consoleInput').placeholder = p.repl ? `type a ${p.name} command (session keeps variables)` : `${p.name} has no interactive session; use Run (F5)`;
    if (modeState && modeState.mode !== 'live') {
      $('consoleInput').disabled = true;
      $('consoleInput').placeholder = 'Learning mode: press F5 to run the editor in the sandbox (no live session)';
    }
    $('stRuntime').textContent = p.runtime ? `${p.runtime.label} · ${s.runtimeFound ? s.runtimeSource : 'not found'}` : 'built-in';
    $('stRtDot').className = 'dot' + (s.runtimeFound ? ' ok' : ' warn');
    const lspText = !p.lsp ? (p.builtinNote ? 'IntelliSense: built-in' : 'IntelliSense: built-in')
      : s.serverRunning ? `IntelliSense: ${p.lsp.name}` : s.serverStarting ? `Starting ${p.lsp.name}…` : s.serverInstalled ? `${p.lsp.name}: idle` : `${p.lsp.name}: not installed`;
    $('stLsp').textContent = lspText;
    $('stLspDot').className = 'dot blue' + ((!p.lsp || s.serverRunning) ? ' ok' : '');
    $('lcdLsp').textContent = (!p.lsp || s.serverRunning) ? 'LSP ●' : 'LSP ○';
    if (preview) updatePreview();
  }

  function updatePreview() {
    const t = activeTab();
    if (!t) return;
    const text = t.model.getValue();
    const isCss = /\.css$/i.test(t.filePath || t.title);
    const html = isCss ? `<style>${text}</style><h1>Heading</h1><p>Paragraph text with a <a href="#">link</a>.</p><button>Button</button>` : text;
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const frame = $('previewFrame');
    const old = frame.dataset.url;
    frame.src = url;
    frame.dataset.url = url;
    if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
  }

  // ---------- console ----------
  const out = $('consoleOut');
  // Batch console output and paint at most once per frame, so a script that prints a
  // lot can't swamp the UI (that was making the window feel stuck while scripts ran).
  let pending = [];
  let flushQueued = false;
  function flush() {
    flushQueued = false;
    const frag = document.createDocumentFragment();
    let last = null;
    for (const [stream, text] of pending) {
      if (last && last.dataset.s === stream && last.textContent.length < 4000) { last.textContent += text; continue; }
      last = el('span', stream === 'out' ? '' : stream, text);
      last.dataset.s = stream;
      frag.append(last);
    }
    pending = [];
    out.append(frag);
    while (out.childNodes.length > 2000) out.removeChild(out.firstChild);
    out.scrollTop = out.scrollHeight;
  }
  function write(stream, text) {
    pending.push([stream, text]);
    if (!flushQueued) { flushQueued = true; requestAnimationFrame(flush); }
  }
  window.poly.onConsole(({ stream, text, tabId }) => {
    if (tabId && tabId !== state.active) {
      const t = state.tabs.find((x) => x.id === tabId);
      if (t) text = text.replace(/^(?=.)/gm, `[${t.title}] `);
    }
    write(stream, text);
  });
  // Which tabs have a script running right now.
  const runningTabs = new Set();
  window.poly.onRunState(({ tabId, running }) => {
    if (running) runningTabs.add(tabId); else runningTabs.delete(tabId);
    renderTabs();
  });
  window.poly.onRunDone(({ code }) => (code === 0 ? Sounds.success() : Sounds.error()));
  $('btnClear').onclick = () => { Sounds.click(); out.textContent = ''; };
  $('btnResetSession').onclick = () => { Sounds.click(); window.poly.resetSession(state.mode); };
  $('consoleForm').onsubmit = (e) => {
    e.preventDefault();
    const line = $('consoleInput').value;
    if (!line.trim()) return;
    $('consoleInput').value = '';
    window.poly.consoleInput({ langId: state.mode, line });
  };

  // ---------- run / save / open ----------
  async function run() {
    const t = activeTab();
    if (!t) return;
    Sounds.click();
    if (profiles[t.langId].mode === 'preview') { updatePreview(); return; }
    await window.poly.runFile({ langId: t.langId, filePath: t.filePath, content: t.model.getValue(), tabId: t.id });
  }
  function runSelection() {
    const t = activeTab();
    if (!t || !profiles[t.langId].repl) return;
    Sounds.click();
    const sel = editor.getSelection();
    let code = t.model.getValueInRange(sel);
    if (!code) code = t.model.getLineContent(sel.startLineNumber); // ISE: F8 with no selection runs the current line
    window.poly.runSelection({ langId: t.langId, code, tabId: t.id });
  }
  async function save(saveAs = false) {
    const t = activeTab();
    if (!t) return;
    const target = await window.poly.saveFile({ filePath: t.filePath, content: t.model.getValue(), langId: t.langId, saveAs });
    if (!target) return;
    Sounds.success();
    if (target !== t.filePath) {
      // Path changed: re-open under the new URI so the server sees the real file.
      const content = t.model.getValue();
      const lang = (langForPath(target) || profiles[t.langId]).id;
      t.dirty = false;
      newTab({ langId: lang, filePath: target, content });
      closeTab(t.id);
    } else { t.dirty = false; renderTabs(); }
  }
  async function open() {
    Sounds.click();
    const files = await window.poly.openFiles();
    for (const f of files) {
      if (!f.langId) { write('err', `No language profile for ${f.path}\n`); continue; }
      const existing = state.tabs.find((t) => t.filePath === f.path);
      if (existing) activate(existing.id); else newTab({ langId: f.langId, filePath: f.path, content: f.content });
    }
  }
  $('btnRun').onclick = run;
  $('btnRunSel').onclick = runSelection;
  $('btnStop').onclick = (e) => { Sounds.click(); window.poly.stop(e.shiftKey ? null : state.active); };
  $('btnStop').title = 'Force-stop this tab\'s script (Shift+click: stop all)';
  $('btnSave').onclick = () => save(false);
  $('btnOpen').onclick = open;
  editor.addCommand(monaco.KeyCode.F5, run);
  editor.addCommand(monaco.KeyCode.F8, runSelection);
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save(false));
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS, () => save(true));
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyO, open);
  window.addEventListener('keydown', (e) => {
    if (document.body.classList.contains('locked')) { e.preventDefault(); e.stopPropagation(); return; }
    if (e.key === 'F5') { e.preventDefault(); run(); }
    if (e.key === 'F8') { e.preventDefault(); runSelection(); }
    if (document.body.classList.contains('locked')) { e.preventDefault(); return; }
    if (e.key === 'Escape') document.querySelectorAll('.overlay').forEach((o) => { o.hidden = true; });
  });
  editor.onDidChangeCursorPosition((e) => { $('stPos').textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`; });

  // ---------- library + drag & drop ----------
  // The user's own commands come first and are marked as theirs.
  function libItems() {
    const p = profiles[state.mode];
    return [...(p.customItems || []).map((i, idx) => ({ ...i, custom: true, idx })), ...(p.libraryItems || [])];
  }
  function renderLibrary() {
    const p = profiles[state.mode];
    $('libSub').textContent = p.name;
    const items = libItems();
    const cats = ['All', ...new Set(items.map((i) => i.cat))];
    const chips = $('libChips'); chips.textContent = '';
    for (const c of cats) {
      const b = el('button', 'chip' + (c === state.libCat ? ' on' : ''), c);
      b.setAttribute('aria-pressed', String(c === state.libCat));
      b.onclick = () => { Sounds.click(); state.libCat = c; renderLibrary(); };
      chips.append(b);
    }
    const q = state.libQuery.toLowerCase();
    const list = $('libList'); list.textContent = '';
    items.filter((i) => (state.libCat === 'All' || i.cat === state.libCat) && (!q || (i.name + ' ' + i.desc).toLowerCase().includes(q)))
      .forEach((i) => {
        const row = el('div', 'lib-item');
        row.draggable = true;
        row.tabIndex = 0;
        const txt = el('div');
        txt.style.minWidth = '0';
        const nameRow = el('div');
        nameRow.style.cssText = 'display:flex;align-items:center;gap:6px;min-width:0';
        nameRow.append(el('div', 'lib-name', i.name));
        if (i.custom) nameRow.append(el('span', 'lib-mine', 'MINE'));
        txt.append(nameRow, el('div', 'lib-desc', i.desc));
        row.append(el('span', 'grip-dots'), txt);
        if (i.custom) {
          const ed = el('button', 'lib-edit', '✎');
          ed.title = 'Edit or delete this command';
          ed.setAttribute('aria-label', `Edit ${i.name}`);
          ed.onclick = (e) => { e.stopPropagation(); openCmdModal(i.idx); };
          ed.ondblclick = (e) => e.stopPropagation();
          row.append(ed);
        }
        row.ondragstart = (e) => {
          e.dataTransfer.setData('application/x-polyise-snippet', i.snippet);
          e.dataTransfer.effectAllowed = 'copy';
          requestAnimationFrame(() => row.classList.add('lift'));
          Sounds.tick();
        };
        row.ondragend = () => { row.classList.remove('lift'); $('dropLine').hidden = true; };
        row.ondblclick = () => insertAtCursor(i.snippet);
        row.onkeydown = (e) => { if (e.key === 'Enter') insertAtCursor(i.snippet); };
        list.append(row);
      });
  }
  $('libSearch').oninput = (e) => { state.libQuery = e.target.value; renderLibrary(); };

  function insertAtCursor(snippet) {
    const pos = editor.getPosition();
    editor.executeEdits('library', [{ range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column), text: snippet }]);
    editor.focus();
    Sounds.clack();
  }

  const wrap = $('editorWrap');
  let dropLineNo = null;
  wrap.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('application/x-polyise-snippet')) return;
    e.preventDefault(); e.stopPropagation();
    const target = editor.getTargetAtClientPoint(e.clientX, e.clientY);
    const lineCount = editor.getModel().getLineCount();
    let line = target && target.position ? target.position.lineNumber : lineCount + 1;
    const rect = $('editor').getBoundingClientRect();
    // Snap to the nearest gap between lines.
    if (target && target.position) {
      const top = editor.getTopForLineNumber(line) - editor.getScrollTop();
      const lh = editor.getOption(monaco.editor.EditorOption.lineHeight);
      if (e.clientY - rect.top > top + lh / 2) line += 1;
    }
    line = Math.min(Math.max(1, line), lineCount + 1);
    dropLineNo = line;
    const y = (line <= lineCount ? editor.getTopForLineNumber(line) : editor.getTopForLineNumber(lineCount) + editor.getOption(monaco.editor.EditorOption.lineHeight)) - editor.getScrollTop();
    const dl = $('dropLine');
    dl.style.top = (rect.top - wrap.getBoundingClientRect().top + y - 1) + 'px';
    dl.hidden = false;
  }, true);
  wrap.addEventListener('dragleave', (e) => { if (!wrap.contains(e.relatedTarget)) $('dropLine').hidden = true; }, true);
  wrap.addEventListener('drop', (e) => {
    const snippet = e.dataTransfer.getData('application/x-polyise-snippet');
    if (!snippet) return;
    e.preventDefault(); e.stopPropagation();
    $('dropLine').hidden = true;
    const model = editor.getModel();
    const lineCount = model.getLineCount();
    const line = dropLineNo || lineCount + 1;
    const indent = line <= lineCount ? (model.getLineContent(line).match(/^\s*/) || [''])[0] : '';
    const text = snippet.split('\n').map((l) => indent + l).join('\n') + '\n';
    const range = line <= lineCount
      ? new monaco.Range(line, 1, line, 1)
      : new monaco.Range(lineCount, model.getLineMaxColumn(lineCount), lineCount, model.getLineMaxColumn(lineCount));
    editor.executeEdits('library-drop', [{ range, text: line <= lineCount ? text : '\n' + text.replace(/\n$/, '') }]);
    const added = snippet.split('\n').length;
    const deco = editor.createDecorationsCollection([{ range: new monaco.Range(line, 1, line + added - 1, 1), options: { isWholeLine: true, className: 'landed' } }]);
    setTimeout(() => deco.clear(), 650);
    editor.setPosition({ lineNumber: line, column: indent.length + 1 });
    editor.focus();
    Sounds.clack();
  }, true);

  // Turn a progress object from the main process into text + bar fill.
  const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
  function busyView(b, startedAt) {
    const secs = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
    const clock = secs ? ` ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : '';
    if (!b || b.phase === 'start') return { text: 'Starting…', width: 0, mode: 'slosh-low' };
    if (b.phase === 'download') {
      if (b.pct === null || b.pct === undefined) return { text: `Downloading ${mb(b.bytes || 0)}`, width: 50, mode: 'slosh' };
      const p = Math.round(b.pct * 100);
      return { text: `Downloading ${p}%`, width: b.pct * 100, mode: 'fill', pct: p };
    }
    if (b.phase === 'unpack') return { text: 'Unpacking…' + clock, width: 100, mode: 'slosh' };
    return { text: 'Installing…' + clock, width: 100, mode: 'slosh' };
  }

  // ---------- Server Manager ----------
  window.poly.onServers((s) => {
    status = s; renderOrbs(); updatePanels();
    if (!$('serversModal').hidden) renderServers();
    if (!$('setupModal').hidden && typeof renderSetup === 'function') renderSetup();
  });

  function renderServers() {
    $('tgAuto').setAttribute('aria-pressed', String(!!settings.autoServers));
    $('tgMulti').setAttribute('aria-pressed', String(!!settings.multiServer));
    const idle = $('idleChips'); idle.textContent = '';
    for (const [label, secs] of [['30 s', 30], ['60 s', 60], ['5 min', 300]]) {
      const b = el('button', 'chip' + (Number(settings.idleSeconds) === secs ? ' on' : ''), label);
      b.onclick = async () => { Sounds.click(); settings = await window.poly.setSettings({ idleSeconds: secs }); renderServers(); };
      idle.append(b);
    }
    const pins = $('pinChips'); pins.textContent = '';
    pins.style.opacity = settings.multiServer ? '1' : '.45';
    for (const s of status.filter((x) => !x.serverBuiltIn)) {
      const on = (settings.pinned || []).includes(s.id);
      const b = el('button', 'chip' + (on ? ' on' : ''), s.short);
      b.setAttribute('aria-pressed', String(on));
      b.title = `Pin ${s.name}`;
      b.onclick = async () => {
        Sounds.click();
        const set = new Set(settings.pinned || []);
        if (on) set.delete(s.id); else set.add(s.id);
        settings = await window.poly.setSettings({ pinned: [...set] });
        renderServers();
      };
      pins.append(b);
    }
    const running = status.filter((s) => s.serverRunning);
    $('smRunning').textContent = `RUNNING ▸ ${running.length}`;
    $('smRunning').title = running.map((s) => s.name).join(', ');
    $('smRunningList').textContent = running.length ? running.map((s) => (s.short === '<>' ? 'HTML' : s.short)).join(' · ') : 'none';

    const rows = $('smRows'); rows.textContent = '';
    for (const s of status) {
      const r = el('div', 'sm-rowx');
      // language
      const lang = el('div', 'sm-lang');
      const orb = el('span', 'sm-orb', s.short);
      orb.style.setProperty('--c', s.orb.color); orb.style.setProperty('--d', s.orb.dark); orb.style.setProperty('--t', s.orb.text);
      const nameBox = el('div'); nameBox.append(el('div', '', s.name));
      nameBox.firstChild.style.fontWeight = '700';
      if (s.bundled) nameBox.append(el('span', 'badge', 'BUNDLED'));
      lang.append(orb, nameBox);
      // server
      const server = el('div', 'sm-server', s.serverName);
      // runtime
      const rt = el('div', 'sm-rt');
      if (s.runtimeBusy !== undefined) {
        const v = busyView(s.runtimeBusy);
        rt.append(el('div', '', `${s.runtimeName}: ${v.text}`));
        const bar = el('div', 'bar'); const i = el('i'); i.style.width = v.width + '%'; bar.append(i); rt.append(bar);
      } else if (s.runtimeFound) {
        rt.textContent = s.runtimeSource === 'builtin' ? 'Built in ✓' : `${s.runtimeName} ✓ (${s.runtimeSource})`;
      } else if (s.runtimeDownload) {
        const b = el('button', 'gloss-btn green small', `Download ${s.runtimeName}`);
        b.onclick = async () => { Sounds.click(); const res = await window.poly.installRuntime(s.id); res.ok ? Sounds.success() : Sounds.error(); };
        rt.append(b);
      } else if (s.runtimeExternal) {
        const a = el('a', '', `Get ${s.runtimeName} ↗`);
        a.onclick = () => window.poly.openExternal(s.runtimeExternal);
        rt.append(a);
      } else rt.textContent = 'not found';
      // status
      const st = el('div');
      if (s.serverBusy !== undefined) {
        const v = busyView(s.serverBusy);
        st.append(el('div', '', v.text));
        const bar = el('div', 'bar'); const i = el('i'); i.style.width = v.width + '%'; bar.append(i); st.append(bar);
      } else if (s.serverBuiltIn) st.append(el('span', 'state run', 'Always on'));
      else if (s.serverRunning) st.append(el('span', 'state run', s.pinned && settings.multiServer && !s.openTabs ? 'Running · pinned' : 'Running'));
      else if (s.serverStarting) st.append(el('span', 'state stop', 'Starting…'));
      else if (s.serverInstalled) st.append(el('span', 'state stop', 'Stopped · idle'));
      else st.append(el('span', 'state none', 'Not installed'));
      // action
      const act = el('div'); act.style.textAlign = 'right';
      if (s.serverBuiltIn) act.append(el('span', 'builtin', 'Built in'));
      else if (s.serverBusy === undefined) {
        const b = s.serverInstalled ? el('button', 'chrome-btn small', 'Uninstall') : el('button', 'gloss-btn blue small', 'Install');
        b.onclick = async () => {
          Sounds.click();
          const res = s.serverInstalled ? await window.poly.uninstallServer(s.id) : await window.poly.installServer(s.id);
          res.ok ? Sounds.success() : Sounds.error();
        };
        act.append(b);
      }
      r.append(lang, server, rt, st, act);
      rows.append(r);
    }
  }

  function openModal(id) { Sounds.click(); $(id).hidden = false; if (id === 'serversModal') window.poly.serverStatus().then((s) => { status = s; renderServers(); }); }
  document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => { Sounds.click(); b.closest('.overlay').hidden = true; }; });
  document.querySelectorAll('.overlay').forEach((o) => { o.onclick = (e) => { if (e.target === o && !document.body.classList.contains('locked') && o.id !== 'setupModal') o.hidden = true; }; });
  $('btnServers').onclick = () => openModal('serversModal');
  $('btnAddLang').onclick = () => openModal('addModal');

  // ---- custom library commands ----
  let cmdEditing = null; // index into the language's customItems, or null for a new one
  function openCmdModal(idx = null) {
    const p = profiles[state.mode];
    if (p.mode === 'preview' && !p.libraryItems) return;
    cmdEditing = idx;
    const it = idx === null ? null : p.customItems[idx];
    $('cmdTitle').textContent = it ? 'EDIT COMMAND' : 'ADD COMMAND';
    $('cmdIntro').textContent = `${it ? 'Change' : 'Add'} a command in the ${p.name} library. It's saved on this PC and kept when POLY-ISE updates.`;
    $('cmdName').value = it ? it.name : '';
    $('cmdDesc').value = it ? it.desc : '';
    $('cmdCat').value = it ? it.cat : (state.libCat !== 'All' ? state.libCat : 'My commands');
    // New command: start from whatever is selected in the editor.
    let sel = '';
    const t = activeTab();
    if (!it && t && editor) sel = t.model.getValueInRange(editor.getSelection());
    $('cmdSnippet').value = it ? it.snippet : sel;
    $('cmdDelete').hidden = !it;
    $('cmdErr').textContent = '';
    const cats = $('cmdCats'); cats.textContent = '';
    for (const c of new Set(['My commands', ...libItems().map((x) => x.cat)])) { const o = document.createElement('option'); o.value = c; cats.append(o); }
    openModal('cmdModal');
    setTimeout(() => $('cmdName').focus(), 50);
  }
  async function saveCustom(items) {
    const p = profiles[state.mode];
    p.customItems = await window.poly.saveCustomLibrary(p.id, items);
    renderLibrary();
  }
  $('btnLibAdd').onclick = () => openCmdModal(null);
  $('cmdSave').onclick = async () => {
    const name = $('cmdName').value.trim(), snippet = $('cmdSnippet').value;
    if (!name) { $('cmdErr').textContent = 'Give the command a name.'; $('cmdName').focus(); return; }
    if (!snippet.trim()) { $('cmdErr').textContent = 'Add the code to insert.'; $('cmdSnippet').focus(); return; }
    const item = { name, desc: $('cmdDesc').value.trim(), cat: $('cmdCat').value.trim() || 'My commands', snippet };
    const items = [...(profiles[state.mode].customItems || [])];
    if (cmdEditing === null) items.unshift(item); else items[cmdEditing] = item;
    await saveCustom(items);
    Sounds.click();
    $('cmdModal').hidden = true;
  };
  $('cmdDelete').onclick = async () => {
    if (cmdEditing === null) return;
    const items = [...profiles[state.mode].customItems];
    const [gone] = items.splice(cmdEditing, 1);
    if (!confirmDelete(gone.name)) return;
    await saveCustom(items);
    $('cmdModal').hidden = true;
  };
  // Two-step delete: the first click arms the button, the second deletes.
  let armed = 0;
  function confirmDelete(name) {
    if (Date.now() - armed < 4000) { armed = 0; return true; }
    armed = Date.now();
    $('cmdErr').textContent = `Click Delete again to remove “${name}”.`;
    return false;
  }
  // Tab in the code box inserts spaces instead of leaving the field.
  $('cmdSnippet').addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const ta = e.target, a = ta.selectionStart;
    ta.setRangeText('    ', a, ta.selectionEnd, 'end');
  });
  $('btnAddOpenServers').onclick = () => { $('addModal').hidden = true; openModal('serversModal'); };
  $('tgAuto').onclick = async () => { Sounds.click(); settings = await window.poly.setSettings({ autoServers: !settings.autoServers }); renderServers(); };
  $('tgMulti').onclick = async () => { Sounds.click(); settings = await window.poly.setSettings({ multiServer: !settings.multiServer }); renderServers(); };
  const requestLanguage = () => {
    const repo = boot.catalogRepo || '';
    if (!repo || repo.startsWith('YOUR-')) { write('sys', 'Set "catalogRepo" in config.json to your GitHub repo to enable language requests.\n'); return; }
    const url = `https://github.com/${repo}/issues/new?labels=language-request&title=${encodeURIComponent('Language request: ')}&body=${encodeURIComponent('Language:\nFile extensions:\nRun command:\nLanguage server (if known):\n')}`;
    window.poly.openExternal(url);
  };
  $('btnRequestLang').onclick = requestLanguage;
  $('btnAddRequest').onclick = requestLanguage;

  // ---------- music ----------
  let media = { available: boot.mediaAvailable, connected: false };
  function renderMusic() {
    const on = media.connected && media.current;
    $('musicOn').hidden = !on;
    $('musicConnect').hidden = !!on;
    $('musicOrb').classList.toggle('on', !!on);
    $('musicOrb').setAttribute('aria-label', on ? 'Disconnect music app' : 'Connect a music app');
    if (!on) return;
    const c = media.current;
    $('musicTitle').textContent = `${c.playing ? '▶' : '❚❚'} ${c.title || 'Unknown'}${c.artist ? ' — ' + c.artist : ''}`;
    $('mPlayIcon').innerHTML = c.playing ? '<rect x="3" y="2" width="3" height="10" fill="#fff"/><rect x="8" y="2" width="3" height="10" fill="#fff"/>' : '<path d="M4 2l8 5-8 5z" fill="#fff"/>';
    if (document.activeElement !== $('mVol') && typeof c.volume === 'number') $('mVol').value = Math.round(c.volume);
    const sel = $('musicApp');
    sel.textContent = '';
    for (const s of media.sessions || []) {
      const o = el('option', '', 'via ' + s.app);
      o.value = s.id; if (s.id === c.id) o.selected = true;
      sel.append(o);
    }
  }
  let lastVolErr = 0;
  window.poly.onMedia((m) => {
    if (m.volumeError || m.error) {
      // Show helper problems in the console, at most once every 30 seconds.
      if (Date.now() - lastVolErr > 30000) { lastVolErr = Date.now(); write('err', `Music: ${m.volumeError ? 'volume: ' + m.volumeError : m.error}\n`); }
      return;
    }
    media = { ...media, ...m }; if (m.available === false) media.connected = false; renderMusic();
  });
  const toggleMusic = () => {
    Sounds.click();
    if (!media.available) { write('sys', 'Music controls are Windows-only (tools/media-helper.ps1 not available).\n'); return; }
    media.connected = !media.connected;
    if (media.connected) window.poly.media('status');
    renderMusic();
  };
  $('musicOrb').onclick = toggleMusic;
  $('musicConnect').onclick = toggleMusic;
  $('mPlay').onclick = () => { Sounds.click(); window.poly.media('toggle'); };
  $('mNext').onclick = () => { Sounds.click(); window.poly.media('next'); };
  $('mPrev').onclick = () => { Sounds.click(); window.poly.media('prev'); };
  let volTimer = null;
  $('mVol').oninput = (e) => {
    const v = e.target.value;
    clearTimeout(volTimer);
    volTimer = setTimeout(() => window.poly.media('vol ' + v), 80);
  };
  $('musicApp').onchange = (e) => window.poly.media('select ' + e.target.value);
  setInterval(() => { if (media.connected) window.poly.media('status'); }, 2000);

  // ---------- window chrome ----------
  $('wClose').onclick = () => window.poly.win.close();
  $('wMin').onclick = () => window.poly.win.minimize();
  $('wMax').onclick = () => window.poly.win.maximize();
  $('grip').addEventListener('mousedown', async (e) => {
    e.preventDefault();
    const start = await window.poly.win.size();
    const sx = e.screenX; const sy = e.screenY;
    const move = (ev) => window.poly.win.resize({ width: start.width + (ev.screenX - sx), height: start.height + (ev.screenY - sy) });
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });


  // ---------- first-run setup ----------
  let setupItems = [];
  let setupBusy = false;
  const setupState = {};
  async function openSetup() {
    resetSetupView();
    $('setupNote').textContent = '';
    setupItems = await window.poly.setupList();
    renderSetup();
    $('setupModal').hidden = false;
  }
  function renderSetup() {
    const box = $('setupList');
    // Build rows once, then only update them, so the liquid animation never restarts.
    if (!box.dataset.built || box.dataset.count !== String(setupItems.length)) {
      box.textContent = '';
      for (const [kind, title] of [['runtime', 'LANGUAGE RUNTIMES (to run code)'], ['server', 'LANGUAGE SERVERS (IntelliSense)']]) {
        box.append(el('div', 'setup-h', title));
        for (const it of setupItems.filter((x) => x.kind === kind)) {
          const row = el('label', 'setup-row');
          row.dataset.id = it.id;
          const liquid = el('div', 'liquid');
          liquid.setAttribute('aria-hidden', 'true');
          for (let i = 0; i < 4; i++) liquid.append(el('i', 'bubble'));
          const cb = el('input'); cb.type = 'checkbox'; cb.dataset.id = it.id;
          cb.checked = !it.installed && it.recommended;
          cb.onchange = () => { setupState[it.id] = { ...(setupState[it.id] || {}), checked: cb.checked }; };
          const txt = el('div', 'setup-txt'); txt.append(el('b', '', it.label), el('small', '', it.desc));
          const bar = el('div', 'setup-bar'); bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-label', `${it.label} progress`);
          row.append(liquid, cb, txt, el('div', 'setup-size', it.size), el('div', 'setup-state'), bar);
          box.append(row);
        }
      }
      box.dataset.built = '1';
      box.dataset.count = String(setupItems.length);
    }
    for (const it of setupItems) {
      const row = box.querySelector(`.setup-row[data-id="${it.id}"]`);
      if (!row) continue;
      const cb = row.querySelector('input');
      const stEl = row.querySelector('.setup-state');
      const liquid = row.querySelector('.liquid');
      const bar = row.querySelector('.setup-bar');
      const st = setupState[it.id] && setupState[it.id].state;
      const live = status.find((x) => x.id === it.lang) || {};
      cb.disabled = it.installed || setupBusy;
      if (it.installed) cb.checked = false;
      let text = '';
      let mode = 'idle';      // idle | fill | slosh | slosh-low | done | failed
      let width = 0;
      let pctNow = null;
      if (it.installed || st === 'done') { text = 'Installed'; mode = 'done'; width = 100; }
      else if (st === 'failed') { text = 'Failed'; mode = 'failed'; width = 100; }
      else if (st === 'working') {
        const s0 = setupState[it.id];
        if (!s0.startedAt) s0.startedAt = Date.now();
        const v = busyView(it.kind === 'runtime' ? live.runtimeBusy : live.serverBusy, s0.startedAt);
        text = v.text; mode = v.mode; width = v.width; pctNow = v.pct ?? null;
      } else if (setupBusy && cb.checked) { text = 'Queued'; }
      stEl.textContent = text;
      stEl.className = 'setup-state ' + (mode === 'done' ? 'done' : mode === 'failed' ? 'failed' : st === 'working' ? 'working' : '');
      stEl.title = st === 'failed' ? setupState[it.id].error : '';
      row.className = 'setup-row ' + mode;
      liquid.style.width = width + '%';
      if (pctNow !== null) bar.setAttribute('aria-valuenow', String(pctNow)); else bar.removeAttribute('aria-valuenow');
    }
  }
  window.poly.onSetup(({ id, state: st, error }) => {
    setupState[id] = { ...(setupState[id] || {}), state: st, error };
    renderSetup();
  });
  $('setupGo').onclick = async () => {
    const ids = [...document.querySelectorAll('#setupList input:checked')].map((c) => c.dataset.id);
    if (!ids.length) { $('setupModal').hidden = true; await window.poly.setSettings({ setupDone: true }); return; }
    Sounds.click();
    setupBusy = true; $('setupGo').disabled = true; $('setupSkip').disabled = true;
    document.body.classList.add('locked');
    $('setupNote').textContent = 'Installing… the app is locked to this window until it finishes. Details also go to the console.';
    renderSetup();
    const clockTimer = setInterval(renderSetup, 1000);
    const res = await window.poly.setupRun(ids);
    clearInterval(clockTimer);
    setupBusy = false; $('setupGo').disabled = false; $('setupSkip').disabled = false;
    // Stay locked until the user acknowledges the result with Continue.
    setupItems = await window.poly.setupList();
    renderSetup();
    status = await window.poly.serverStatus(); renderOrbs(); updatePanels();
    showSetupResult(res);
  };

  // After an install run: summary screen that the user acknowledges with Continue.
  function showSetupResult(res) {
    const byId = Object.fromEntries(setupItems.map((i) => [i.id, i]));
    const failed = res.filter((r) => !r.ok);
    const ok = res.filter((r) => r.ok);
    $('setupList').hidden = true;
    $('setupActions').hidden = true;
    $('setupNote').textContent = '';
    $('setupDone').hidden = false;
    $('setupDoneTitle').textContent = failed.length ? 'SETUP FINISHED · ' + failed.length + ' PROBLEM' + (failed.length > 1 ? 'S' : '') : 'SETUP COMPLETE';
    $('setupDoneTitle').classList.toggle('warn', failed.length > 0);
    $('setupDoneText').textContent = failed.length
      ? `${ok.length} item(s) installed. The ones below failed; the app still works without them, and you can retry now or later from Servers → Setup wizard.`
      : `Everything you picked is installed (${ok.length} item${ok.length === 1 ? '' : 's'}). POLY//ISE is ready to use.`;
    const list = $('setupDoneList'); list.textContent = '';
    for (const r of [...failed, ...ok]) {
      const li = el('li', r.ok ? 'ok' : 'bad', (byId[r.id] || {}).label || r.id);
      if (!r.ok) li.append(el('small', '', r.error));
      list.append(li);
    }
    $('setupRetry').hidden = failed.length === 0;
    $('setupRetry').onclick = () => {
      Sounds.click();
      resetSetupView();
      failed.forEach((f) => { setupState[f.id] = { checked: true }; });
      $('setupList').querySelectorAll('input').forEach((cb) => { cb.checked = failed.some((f) => f.id === cb.dataset.id); });
      renderSetup();
      $('setupGo').click();
    };
    $('setupContinue').onclick = async () => {
      Sounds.click();
      resetSetupView();
      document.body.classList.remove('locked');
      $('setupModal').hidden = true;
      settings = await window.poly.setSettings({ setupDone: true });
    };
    $('setupContinue').focus();
  }

  function resetSetupView() {
    $('setupDone').hidden = true;
    $('setupList').hidden = false;
    $('setupActions').hidden = false;
  }

  $('setupSkip').onclick = async () => { Sounds.click(); $('setupModal').hidden = true; settings = await window.poly.setSettings({ setupDone: true }); };
  $('btnSetupWizard').onclick = () => { $('serversModal').hidden = true; openSetup(); };

  // Track whether any sub-menu is open, to dim the window behind it.
  const syncModal = () => document.body.classList.toggle('modal-open', [...document.querySelectorAll('.overlay')].some((o) => !o.hidden));
  const mo = new MutationObserver(syncModal);
  document.querySelectorAll('.overlay').forEach((o) => mo.observe(o, { attributes: true, attributeFilter: ['hidden'] }));
  syncModal();

  // ---------- Learning / Live ----------
  modeState = await window.poly.getMode();
  function renderMode() {
    const live = modeState.mode === 'live';
    $('modeSwitch').setAttribute('aria-checked', String(live));
    document.body.classList.toggle('live-mode', live);
    // The interactive session only exists in Live mode.
    $('btnResetSession').hidden = !live;
    if (!live) { $('consoleInput').disabled = true; $('consoleInput').placeholder = 'Learning mode: press F5 to run the editor in the sandbox (no live session)'; }
    else updatePanels();
    const sb = modeState.sandboxState;
    $('stModeText').textContent = live ? 'LIVE: scripts change this PC'
      : !modeState.sandbox ? 'Learning: Sandbox not enabled'
      : sb === 'ready' ? 'Learning: sandbox ready' : sb === 'booting' ? 'Learning: sandbox starting…' : sb === 'failed' ? 'Learning: sandbox failed (click to retry)' : 'Learning: sandbox idle';
    $('stModeDot').className = 'dot ' + (live ? 'live' : sb === 'ready' ? 'ok' : 'warn');
    $('stMode').title = live ? '' : 'Click to reset the Learning sandbox (wipes everything inside it)';
  }
  async function setMode2(want) {
    $('modeSwitch').classList.add('waiting');
    if (want === 'live') write('sys', 'Waiting for Windows to confirm Live mode (UAC)…\n');
    modeState = await window.poly.setMode(want);
    $('modeSwitch').classList.remove('waiting');
    renderMode();
    modeState.mode === want ? Sounds.success() : Sounds.error();
  }
  $('modeSwitch').onclick = () => { Sounds.click(); setMode2(modeState.mode === 'live' ? 'learning' : 'live'); };
  window.poly.onSandboxMissing(() => openModal('sandboxModal'));
  $('sbLive').onclick = () => { $('sandboxModal').hidden = true; setMode2('live'); };
  $('sbEnable').onclick = async () => {
    Sounds.click();
    write('sys', 'Asking Windows to turn on Windows Sandbox (UAC)…\n');
    const ok = await window.poly.enableSandbox();
    write(ok ? 'sys' : 'err', ok ? 'Windows Sandbox turned on. Restart the PC, then Learning mode will work.\n' : 'Windows Sandbox was not turned on (cancelled or not supported on this PC).\n');
    $('sandboxModal').hidden = true;
  };
  window.poly.onSandboxState(({ state: s, seconds }) => {
    modeState.sandboxState = s;
    renderMode();
    if (s === 'ready' && seconds) write('sys', `Learning sandbox ready (${seconds}s). Runs now start in a few seconds.\n`);
    if (s === 'failed') write('err', 'Learning sandbox failed to start. Click the status pill to retry, or switch to Live.\n');
  });
  $('stMode').style.cursor = 'pointer';
  $('stMode').onclick = async () => {
    if (modeState.mode === 'live' || !modeState.sandbox) return;
    Sounds.click();
    write('sys', 'Resetting the Learning sandbox…\n');
    await window.poly.resetSandbox();
  };
  renderMode();

  // ---------- start ----------
  renderOrbs();
  renderLibrary();
  newTab({ langId: state.mode });
  typeLcd(`MODE ▸ ${profiles[state.mode].name.toUpperCase()}`);
  if (!settings.setupDone) openSetup();
  write('sys', 'POLY//ISE ready. F5 runs the tab, F8 runs the selection in a session that keeps variables.\n');
})();
