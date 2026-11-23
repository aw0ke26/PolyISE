// Connects Monaco to language servers running in the main process.
// Completions, hover and diagnostics are translated between LSP and Monaco shapes.
const LspBridge = (() => {
  const models = new Map(); // normalized uri -> { model, langId }

  const norm = (uri) => decodeURIComponent(uri).replace(/^file:\/\/\/([A-Za-z]):/, (m, d) => `file:///${d.toLowerCase()}:`).toLowerCase();

  function fileUri(p) {
    let s = p.replace(/\\/g, '/');
    if (!s.startsWith('/')) s = '/' + s;
    return 'file://' + s.split('/').map((seg, i) => (i === 1 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join('/');
  }

  function kindMap(k) {
    const K = monaco.languages.CompletionItemKind;
    const m = { 1: K.Text, 2: K.Method, 3: K.Function, 4: K.Constructor, 5: K.Field, 6: K.Variable, 7: K.Class, 8: K.Interface,
      9: K.Module, 10: K.Property, 11: K.Unit, 12: K.Value, 13: K.Enum, 14: K.Keyword, 15: K.Snippet, 16: K.Color, 17: K.File,
      18: K.Reference, 19: K.Folder, 20: K.EnumMember, 21: K.Constant, 22: K.Struct, 23: K.Event, 24: K.Operator, 25: K.TypeParameter };
    return m[k] || K.Text;
  }

  function docText(d) {
    if (!d) return undefined;
    if (typeof d === 'string') return d;
    if (d.value !== undefined) return { value: d.value };
    return undefined;
  }

  function hoverContents(c) {
    if (!c) return [];
    const one = (x) => (typeof x === 'string' ? { value: x } : x.language ? { value: '```' + x.language + '\n' + x.value + '\n```' } : { value: x.value });
    return Array.isArray(c) ? c.map(one) : [one(c)];
  }

  const pos = (p) => ({ line: p.lineNumber - 1, character: p.column - 1 });

  function register(profile) {
    if (!profile.lsp) return;
    const langs = [profile.monaco, ...Object.values(profile.monacoByExt || {})];
    for (const lang of langs) {
      monaco.languages.registerCompletionItemProvider(lang, {
        triggerCharacters: ['.', '-', '$', ':', '>', '/', '"'],
        async provideCompletionItems(model, position) {
          const entry = models.get(norm(model.uri.toString(true)));
          if (!entry) return { suggestions: [] };
          const res = await window.poly.lspRequest({ langId: entry.langId, method: 'textDocument/completion',
            params: { textDocument: { uri: entry.uri }, position: pos(position) } });
          const items = Array.isArray(res) ? res : (res && res.items) || [];
          const word = model.getWordUntilPosition(position);
          const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
          return {
            suggestions: items.slice(0, 300).map((it) => ({
              label: it.label,
              kind: kindMap(it.kind),
              detail: it.detail,
              documentation: docText(it.documentation),
              insertText: (it.textEdit && it.textEdit.newText) || it.insertText || it.label,
              insertTextRules: it.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
              sortText: it.sortText, filterText: it.filterText, range
            }))
          };
        }
      });
      monaco.languages.registerHoverProvider(lang, {
        async provideHover(model, position) {
          const entry = models.get(norm(model.uri.toString(true)));
          if (!entry) return null;
          const res = await window.poly.lspRequest({ langId: entry.langId, method: 'textDocument/hover',
            params: { textDocument: { uri: entry.uri }, position: pos(position) } });
          if (!res || !res.contents) return null;
          return { contents: hoverContents(res.contents) };
        }
      });
    }
  }

  function track(model, uri, langId) {
    models.set(norm(model.uri.toString(true)), { model, uri, langId });
    models.set(norm(uri), { model, uri, langId });
  }

  function untrack(model, uri) {
    models.delete(norm(model.uri.toString(true)));
    models.delete(norm(uri));
  }

  function onDiagnostics(params) {
    const entry = models.get(norm(params.uri));
    if (!entry) return;
    const sev = { 1: monaco.MarkerSeverity.Error, 2: monaco.MarkerSeverity.Warning, 3: monaco.MarkerSeverity.Info, 4: monaco.MarkerSeverity.Hint };
    monaco.editor.setModelMarkers(entry.model, 'lsp', (params.diagnostics || []).map((d) => ({
      severity: sev[d.severity] || monaco.MarkerSeverity.Error,
      message: d.message, source: d.source,
      startLineNumber: d.range.start.line + 1, startColumn: d.range.start.character + 1,
      endLineNumber: d.range.end.line + 1, endColumn: d.range.end.character + 1
    })));
  }

  return { register, track, untrack, onDiagnostics, fileUri };
})();
