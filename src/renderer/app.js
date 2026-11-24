// Cena — aplicação (interface).
import { platform, call, saveBytes, pickFile } from './platform.js';
import { h, toast, modal, confirmBox, prompt, debounce, timeAgo } from './ui.js';
import {
  createEditor, setDoc, editorConfig, relint, clearSpellCache, setPageBreaks,
  getSuggestions, acceptAll, rejectAll, nextSuggestion, currentScene, sceneRanges, goTo,
} from './editor.js';
import { createClaudePanel } from './claude-panel.js';
import { Speller } from '../core/spell.js';
import { fromFDX } from '../core/fdx.js';
import { fixFormatting } from '../core/format.js';
import { stats } from '../core/stats.js';
import { DEFAULT_MODEL_LIST } from './models.js';
import { undo } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';

const $ = (s) => document.querySelector(s);

const app = {
  settings: null,
  info: null,
  doc: { path: null, name: '', text: '', savedText: '', mtime: 0 },
  save: { state: 'saved', at: 0, error: null },
  cloud: { state: 'off', at: 0, error: null },
  view: null,
  panel: null,
};

// ---------------------------------------------------------------------------
// Inicialização

async function init() {
  app.info = await call('app.info');
  app.settings = await call('settings.get');
  applyTheme();
  document.body.classList.toggle('web', platform.mode === 'web');

  app.view = createEditor($('#editor'), {
    onChange: onDocChange,
    onSelection: debounce(updateStatus, 150),
    onUpdate: updateReviewBar,
  });
  app.panel = createClaudePanel({
    root: $('#panel'),
    getView: () => app.view,
    getDoc: () => ({ ...app.doc, text: app.view.state.doc.toString() }),
    getSettings: () => app.settings,
    onStatus: (s) => { app.claudeStatus = s; updateStatus(); },
  });
  $('#panel').addEventListener('setting', (e) => updateSettings(e.detail));
  $('#panel').addEventListener('undo', () => undo(app.view));

  applyEditorSettings();
  bindKeys();
  platform.onOpenFile?.((p) => openPath(p));
  platform.onBeforeClose?.(() => flushAll());
  addEventListener('focus', checkDiskChange);
  setInterval(() => { if (app.cloud.state === 'error' || app.cloud.state === 'pending') pushCloud(); updateStatus(); }, 30000);

  // documento inicial: arquivo passado na linha de comando, o último aberto, ou um novo
  const pending = platform.mode === 'desktop' ? await call('app.pendingOpen') : null;
  const list = await call('doc.list');
  if (pending) await openPath(pending);
  else if (list.recent[0]) await openPath(list.recent[0].path);
  else await newDoc(true);

  loadSpeller();
  $('#hint-k').textContent = 'Ctrl+K';
  setTimeout(() => document.body.classList.add('ready'), 50);
}

async function loadSpeller() {
  try {
    const { aff, dic } = await call('dict.get', { lang: app.settings.lang });
    await new Promise((r) => setTimeout(r, 0));
    editorConfig.speller = new Speller(aff, dic);
    clearSpellCache();
    relint(app.view);
  } catch (e) { console.warn('dicionário', e); }
}

function applyTheme() {
  const t = app.settings.theme;
  document.documentElement.dataset.theme = t === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : t;
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => app.settings && applyTheme());

function applyEditorSettings() {
  const s = app.settings;
  editorConfig.settings = s;
  editorConfig.userWords = new Set(s.userWords);
  editorConfig.onAddWord = (w) => call('dict.addWord', { word: w }).then(() => { app.settings.userWords.push(w); });
  editorConfig.languagetool = s.languagetool.enabled ? languageTool : null;
  document.body.classList.toggle('focus-mode', !!app.focusMode);
  if (app.view) relint(app.view);
}

async function updateSettings(patch) {
  const prevLang = app.settings.lang;
  app.settings = await call('settings.set', { patch });
  applyTheme();
  applyEditorSettings();
  if (app.settings.lang !== prevLang) loadSpeller();
  app.stats = null;
  app.panel.render();
  updateStatus();
}

// LanguageTool: verifica parágrafos de ação e diálogo, com cache por parágrafo
const ltCache = new Map();
async function languageTool(state) {
  const doc = state.doc.toString();
  const paras = [];
  const re = /[^\n]+(?:\n[^\n]+)*/g;
  let m;
  while ((m = re.exec(doc))) {
    const t = m[0];
    if (t.length < 12 || /^(INT|EXT|Title:|#|=|\[\[)/i.test(t)) continue;
    paras.push({ from: m.index, text: t });
  }
  const missing = paras.filter((p) => !ltCache.has(p.text)).slice(0, 40);
  if (missing.length) {
    const joined = missing.map((p) => p.text).join('\n\n');
    const { matches } = await call('grammar.languagetool', { text: joined.slice(0, 20000) });
    let off = 0;
    for (const p of missing) {
      const end = off + p.text.length;
      ltCache.set(p.text, matches.filter((x) => x.offset >= off && x.offset + x.length <= end).map((x) => ({ ...x, offset: x.offset - off })));
      off = end + 2;
    }
  }
  return paras.flatMap((p) => (ltCache.get(p.text) || []).map((x) => ({ from: p.from + x.offset, to: p.from + x.offset + x.length, message: x.message, replacements: x.replacements })));
}

// ---------------------------------------------------------------------------
// Documentos e salvamento automático

function loadIntoEditor(d) {
  app.doc = { path: d.path, name: d.name, text: d.text, savedText: d.text, mtime: d.mtime };
  setDoc(app.view, d.text);
  app.save = { state: 'saved', at: d.mtime, error: null };
  document.title = `${d.name.replace(/\.fountain$/i, '')} — Cena`;
  $('#docname').textContent = d.name.replace(/\.fountain$/i, '');
  app.panel.loadProduction();
  updateStatus();
  app.view.focus();
  checkCloud();
}

async function openPath(p) {
  await flushAll();
  try {
    if (/\.fdx$/i.test(p)) return importFDXFromPath(p);
    loadIntoEditor(await call('doc.read', { path: p }));
  } catch (e) { toast(`Não foi possível abrir: ${e.message}`, { error: true }); }
}

async function newDoc(first = false) {
  await flushAll();
  const d = await call('doc.new', {});
  loadIntoEditor(d);
  if (first) toast('Novo roteiro. Tab alterna os elementos; Ctrl+K mostra todos os comandos.', { ms: 6000 });
}

const autosave = debounce(() => saveNow(), 900);
const autoCloud = debounce(() => pushCloud(), 4000);
const autoStats = debounce(() => { app.stats = null; updateStatus(); }, 500);

function onDocChange() {
  app.save.state = 'dirty';
  autosave();
  autoStats();
  app.panel.onEdit();
  document.body.classList.add('typing');
  clearTimeout(app.typingTimer);
  app.typingTimer = setTimeout(() => document.body.classList.remove('typing'), 1800);
  updateStatus();
}

async function saveNow({ snapshot = false } = {}) {
  if (!app.doc.path) return;
  const text = app.view.state.doc.toString();
  if (text === app.doc.savedText && !snapshot) { app.save.state = 'saved'; updateStatus(); return; }
  app.save.state = 'saving'; updateStatus();
  try {
    const r = await call('doc.save', { path: app.doc.path, text, snapshot });
    app.doc.savedText = text;
    app.doc.mtime = r.mtime;
    app.save = { state: app.view.state.doc.toString() === text ? 'saved' : 'dirty', at: r.savedAt, error: null };
    if (app.settings.cloud.provider !== 'none') { app.cloud.state = 'pending'; autoCloud(); }
  } catch (e) {
    app.save = { state: 'error', at: app.save.at, error: e.message };
    toast(`Erro ao salvar: ${e.message}`, { error: true });
  }
  updateStatus();
}

async function pushCloud() {
  if (app.settings.cloud.provider === 'none' || !app.doc.path) { app.cloud.state = 'off'; updateStatus(); return; }
  app.cloud.state = 'syncing'; updateStatus();
  try {
    const r = await call('cloud.push', { path: app.doc.path, text: app.doc.savedText });
    app.cloud = { state: r.status === 'off' ? 'off' : 'synced', at: r.at || Date.now(), error: null };
    if (r.status === 'conflict') toast(`Outra versão foi salva na nuvem por outro dispositivo. Ela foi guardada como: ${r.conflictPath}`, { ms: 10000 });
  } catch (e) {
    app.cloud = { state: 'error', at: app.cloud.at, error: e.message };
  }
  updateStatus();
}

async function checkCloud() {
  if (app.settings.cloud.provider === 'none' || !app.doc.path) { app.cloud.state = 'off'; return; }
  try {
    const r = await call('cloud.check', { path: app.doc.path, text: app.doc.savedText });
    if (r.status === 'remote-changed') {
      const choice = await confirmBox('Versão mais nova na nuvem',
        `A cópia de "${app.doc.name}" na nuvem foi alterada${r.modified ? ` em ${new Date(r.modified).toLocaleString('pt-BR')}` : ''} e é diferente desta. Qual usar? A outra fica no histórico de versões.`,
        [{ label: 'Manter a deste computador', value: 'local' }, { label: 'Usar a da nuvem', value: 'remote', primary: true }]);
      if (choice === 'remote') {
        await call('doc.save', { path: app.doc.path, text: app.doc.savedText, snapshot: true });
        setDoc(app.view, r.text);
        await saveNow({ snapshot: true });
        await call('cloud.accept', { path: app.doc.path, text: r.text, etag: r.etag });
        app.cloud = { state: 'synced', at: Date.now() };
      } else {
        await pushCloud();
      }
    } else if (r.status === 'absent') { pushCloud(); } else app.cloud = { state: 'synced', at: Date.now() };
  } catch (e) { app.cloud = { state: 'error', at: 0, error: e.message }; }
  updateStatus();
}

async function checkDiskChange() {
  if (!app.doc.path) return;
  const st = await call('doc.statDisk', { path: app.doc.path }).catch(() => null);
  if (!st || st.mtime <= app.doc.mtime + 5) return;
  const d = await call('doc.read', { path: app.doc.path });
  if (d.text === app.view.state.doc.toString()) { app.doc.mtime = d.mtime; return; }
  const unchanged = app.view.state.doc.toString() === app.doc.savedText;
  if (unchanged) { const sel = app.view.state.selection.main.head; setDoc(app.view, d.text); app.doc.savedText = d.text; app.doc.mtime = d.mtime; goTo(app.view, Math.min(sel, d.text.length)); toast('O arquivo foi alterado fora do Cena e foi recarregado.'); }
}

async function flushAll() {
  autosave.cancel();
  await saveNow();
  autoCloud.cancel();
  if (app.cloud.state === 'pending') await pushCloud();
}

// ---------------------------------------------------------------------------
// Barra de revisão das alterações propostas pelo Claude

let lastReviewCount = -1;
function updateReviewBar() {
  if (!app.view) return;
  const n = getSuggestions(app.view.state).length;
  if (n === lastReviewCount) return;
  lastReviewCount = n;
  const bar = $('#review');
  bar.classList.toggle('show', n > 0);
  if (!n) { bar.replaceChildren(); return; }
  bar.replaceChildren(
    h('span', {}, `Claude: ${n} alteraç${n === 1 ? 'ão' : 'ões'}`),
    h('button', { onclick: () => nextSuggestion(app.view), title: 'Ir para a próxima' }, 'Próxima'),
    h('button', { onclick: () => { rejectAll(app.view); app.view.focus(); } }, 'Rejeitar todas'),
    h('button', { class: 'primary', onclick: () => { const k = acceptAll(app.view); app.view.focus(); toast(`${k} alteraç${k === 1 ? 'ão aceita' : 'ões aceitas'}.`, { action: { label: 'Desfazer', run: () => undo(app.view) } }); } }, 'Aceitar todas'));
}

// ---------------------------------------------------------------------------
// Barra de status (discreta, some enquanto se digita)

function updateStatus() {
  if (!app.view) return;
  if (!app.stats) {
    try {
      app.stats = stats(app.view.state.doc.toString(), { paper: app.settings.paper, lang: app.settings.lang });
      setPageBreaks(app.view, app.stats.pageStarts, app.stats.hasTitle);
    } catch (e) { console.warn(e); app.stats = { pages: 0, scenes: [], pageStarts: [] }; }
  }
  // página em que está o cursor
  const curLine = app.view.state.doc.lineAt(app.view.state.selection.main.head).number - 1;
  let curPage = 0;
  for (const p of app.stats.pageStarts) if (p.line <= curLine) curPage = p.page;
  const sc = currentScene(app.view);
  const saveTxt = { saved: 'salvo', dirty: 'editando', saving: 'salvando…', error: 'erro ao salvar' }[app.save.state];
  const cloudTxt = { off: '', pending: 'nuvem ⋯', syncing: 'nuvem ⟳', synced: 'nuvem ✓', error: 'nuvem ⚠' }[app.cloud.state] || '';
  const parts = [
    curPage ? `pág. ${curPage}/${app.stats.pages}` : `${app.stats.pages} pág.`,
    sc.total ? (sc.index >= 0 ? `cena ${sc.index + 1}/${sc.total}` : `${sc.total} cenas`) : null,
    saveTxt,
    cloudTxt || null,
    app.claudeStatus || null,
  ].filter(Boolean);
  const el = $('#status');
  el.textContent = parts.join('  ·  ');
  el.title = [
    app.save.at ? `Salvo ${timeAgo(app.save.at)} em ${app.doc.path}` : app.doc.path,
    app.cloud.state === 'error' ? `Nuvem: ${app.cloud.error} (tentando de novo)` : app.cloud.at ? `Nuvem sincronizada ${timeAgo(app.cloud.at)}` : 'Nuvem desativada — configure em Configurações',
  ].join('\n');
  el.classList.toggle('warn', app.save.state === 'error' || app.cloud.state === 'error');
}

// ---------------------------------------------------------------------------
// Exportar / importar

const baseName = () => (app.doc.name || 'roteiro').replace(/\.fountain$/i, '');

async function exportAs(format) {
  await flushAll();
  try {
    const out = await call('export.file', { format, text: app.view.state.doc.toString() });
    const r = await saveBytes(`${baseName()}.${out.ext}`, out.base64, out.ext, out.mime);
    if (r) toast(`Exportado: ${r.path}`, platform.mode === 'desktop' ? { action: { label: 'Mostrar', run: () => call('shell.show', { path: r.path }) } } : {});
  } catch (e) { toast(`Erro ao exportar: ${e.message}`, { error: true }); }
}

async function importFDX() {
  if (platform.mode === 'desktop') {
    const r = await call('dialog.open');
    if (!r) return;
    if (r.fdx) return importFDXText(r.fdx, r.path.split('/').pop());
    return openPath(r.path);
  }
  const f = await pickFile('.fdx,.fountain,.txt');
  if (!f) return;
  if (/\.fdx$/i.test(f.name)) return importFDXText(f.text, f.name);
  await flushAll();
  const d = await call('doc.new', { title: f.name.replace(/\.(fountain|txt)$/i, '') });
  await call('doc.save', { path: d.path, text: f.text });
  loadIntoEditor({ ...d, text: f.text });
}

async function importFDXFromPath(p) {
  const { text } = await call('file.readText', { path: p });
  return importFDXText(text, p.split('/').pop());
}

async function importFDXText(xmlText, name) {
  try {
    const fountain = fromFDX(xmlText);
    await flushAll();
    const d = await call('doc.new', { title: name.replace(/\.fdx$/i, '') });
    await call('doc.save', { path: d.path, text: fountain, snapshot: true });
    loadIntoEditor({ ...d, text: fountain });
    toast(`Importado do Final Draft para ${d.name}`);
  } catch (e) { toast(`Falha ao importar FDX: ${e.message}`, { error: true }); }
}

// ---------------------------------------------------------------------------
// Comandos

function fixAllFormatting() {
  const text = app.view.state.doc.toString();
  const { text: fixed, changes } = fixFormatting(text);
  if (fixed === text) { toast('A formatação já está correta.'); return; }
  app.view.dispatch({ changes: { from: 0, to: text.length, insert: fixed }, userEvent: 'input.format' });
  toast(`${changes.length} ajuste${changes.length !== 1 ? 's' : ''} de formatação.`, { action: { label: 'Desfazer', run: () => undo(app.view) } });
}

async function openLibrary() {
  const list = await call('doc.list');
  const fmt = (f) => h('li', {}, h('button', { class: 'file', onclick: () => { m.close(); openPath(f.path); } },
    h('span', {}, f.name.replace(/\.fountain$/i, '')), h('span', { class: 'muted small' }, timeAgo(f.mtime))));
  const recentPaths = new Set(list.recent.map((r) => r.path));
  const m = modal('Abrir roteiro', h('div', { class: 'library' },
    list.recent.length ? [h('h3', {}, 'Recentes'), h('ul', {}, list.recent.map(fmt))] : null,
    h('h3', {}, 'Biblioteca'), h('p', { class: 'muted small path' }, list.library),
    h('ul', {}, list.files.filter((f) => !recentPaths.has(f.path)).map(fmt)),
    h('div', { class: 'row end' },
      h('button', { onclick: () => { m.close(); importFDX(); } }, platform.mode === 'desktop' ? 'Outro arquivo…' : 'Enviar arquivo (.fountain / .fdx)…'),
      h('button', { class: 'primary', onclick: () => { m.close(); newDoc(); } }, 'Novo roteiro'))));
}

const openDialog = () => openLibrary();

async function renameDoc() {
  const name = await prompt('Renomear roteiro', baseName());
  if (!name || name === baseName()) return;
  await flushAll();
  try {
    const r = await call('doc.rename', { path: app.doc.path, name });
    app.doc.path = r.path; app.doc.name = r.name;
    $('#docname').textContent = r.name.replace(/\.fountain$/i, '');
    document.title = `${r.name.replace(/\.fountain$/i, '')} — Cena`;
    pushCloud();
  } catch (e) { toast(e.message, { error: true }); }
}

async function saveCopyAs() {
  await flushAll();
  if (platform.mode === 'desktop') {
    const r = await call('dialog.saveFountain', { name: app.doc.name });
    if (!r) return;
    await call('doc.save', { path: r.path, text: app.view.state.doc.toString() });
    loadIntoEditor(await call('doc.read', { path: r.path }));
    toast(`Agora editando ${r.path}`);
  } else exportAs('fountain');
}

async function showHistory() {
  await saveNow({ snapshot: true });
  const versions = await call('history.list', { path: app.doc.path });
  const preview = h('pre', { class: 'preview' }, 'Escolha uma versão.');
  let chosen = null;
  const restore = h('button', { class: 'primary', disabled: true, onclick: async () => {
    m.close();
    await saveNow({ snapshot: true });
    setDoc(app.view, chosen);
    await saveNow({ snapshot: true });
    toast('Versão restaurada. A anterior continua no histórico.');
  } }, 'Restaurar esta versão');
  const m = modal('Histórico de versões', h('div', { class: 'history' },
    h('ul', {}, versions.map((v) => h('li', {}, h('button', { class: 'file', onclick: async (e) => {
      for (const b of e.currentTarget.closest('ul').querySelectorAll('.file')) b.classList.remove('sel');
      e.currentTarget.classList.add('sel');
      chosen = (await call('history.read', { path: app.doc.path, id: v.id })).text;
      preview.textContent = chosen.slice(0, 6000) + (chosen.length > 6000 ? '\n…' : '');
      restore.disabled = false;
    } }, new Date(v.at).toLocaleString('pt-BR'), h('span', { class: 'muted small' }, ` ${Math.round(v.size / 1024 * 10) / 10} KB`))))),
    preview,
    h('div', { class: 'row end full' }, restore)), { wide: true });
}

function goToScene() {
  const scenes = sceneRanges(app.view);
  if (!scenes.length) { toast('Ainda não há cenas.'); return; }
  palette(scenes.map((s, i) => ({ label: `${i + 1}  ${s.text.replace(/^\./, '')}`, run: () => goTo(app.view, s.from) })), 'Ir para cena…');
}

function toggleFocus() {
  app.focusMode = !app.focusMode;
  document.body.classList.toggle('focus-mode', app.focusMode);
  toast(app.focusMode ? 'Modo foco ativado (Ctrl+Shift+F11 para sair)' : 'Modo foco desativado', { ms: 1600 });
}

function togglePanel(tab) {
  const open = document.body.classList.contains('panel-open');
  if (open && (!tab || app.panelTab === tab)) { document.body.classList.remove('panel-open'); app.view.focus(); return; }
  document.body.classList.add('panel-open');
  if (tab) { app.panelTab = tab; app.panel.setTab(tab); }
}

function showHelp() {
  const rows = [
    ['Tab / Shift+Tab', 'alterna o elemento: ação → personagem → cena → transição'],
    ['Tab numa linha vazia após a fala', 'insere um parentético ( )'],
    ['Enter', 'segue o fluxo do roteiro (personagem → fala → ação)'],
    ['Shift+Enter', 'quebra de linha simples'],
    ['Ctrl+B / Ctrl+I / Ctrl+U', 'negrito / itálico / sublinhado'],
    ['Ctrl+K', 'todos os comandos'],
    ['Ctrl+G', 'ir para cena'],
    ['Ctrl+J', 'painel do Claude'],
    ['Ctrl+Shift+L', 'conversar com o Claude'],
    ['Ctrl+Shift+E', 'pedir ao Claude para editar a seleção ou a cena'],
    ['Ctrl+Shift+G', 'revisar o português da cena com o Claude'],
    ['Ctrl+Shift+I', 'corrigir formatação do roteiro'],
    ['Ctrl+F', 'buscar e substituir'],
    ['Ctrl+E', 'exportar PDF'],
    ['Ctrl+,', 'configurações'],
    ['F11 / Ctrl+Shift+F11', 'tela cheia / modo foco'],
  ];
  const syntax = [
    ['INT. CASA - DIA', 'cabeçalho de cena (ou .QUALQUER COISA)'],
    ['NOME', 'personagem (linha em maiúsculas com fala logo abaixo); @Nome força'],
    ['(rindo)', 'parentético'],
    ['CORTA PARA:', 'transição (ou > TEXTO)'],
    ['> TEXTO <', 'centralizado'],
    ['NOME ^', 'diálogo duplo (simultâneo)'],
    ['*itálico*  **negrito**  _sublinhado_', 'ênfase'],
    ['[[nota]]  /* trecho */', 'nota e trecho oculto (não impressos)'],
    ['# Ato  /  = sinopse', 'estrutura (não impressa)'],
    ['===', 'quebra de página'],
  ];
  modal('Atalhos e formato', h('div', { class: 'help' },
    h('table', {}, rows.map(([k, v]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, v)))),
    h('h3', {}, 'Fountain — o formato aberto do Cena'),
    h('table', {}, syntax.map(([k, v]) => h('tr', {}, h('td', {}, h('code', {}, k)), h('td', {}, v)))),
    h('p', { class: 'muted small' }, `Cena ${app.info.version} · arquivos .fountain são texto puro e abrem em qualquer editor, no Beat, Highland, Slugline, WriterSolo e outros.`)), { wide: true });
}

const COMMANDS = () => [
  { label: 'Novo roteiro', key: 'Ctrl+N', run: () => newDoc() },
  { label: 'Abrir…', key: 'Ctrl+O', run: openDialog },
  { label: 'Renomear', run: renameDoc },
  { label: 'Salvar cópia como…', key: 'Ctrl+Shift+S', run: saveCopyAs },
  { label: 'Exportar PDF', key: 'Ctrl+E', run: () => exportAs('pdf') },
  { label: 'Exportar Final Draft (.fdx)', run: () => exportAs('fdx') },
  { label: 'Exportar Fountain (.fountain)', run: () => exportAs('fountain') },
  { label: 'Importar Final Draft (.fdx)…', run: importFDX },
  { label: 'Ir para cena…', key: 'Ctrl+G', run: goToScene },
  { label: 'Corrigir formatação do roteiro', key: 'Ctrl+Shift+I', run: fixAllFormatting },
  { label: 'Claude: editar o texto (seleção ou cena)…', key: 'Ctrl+Shift+E', run: () => app.panel.editPrompt('auto') },
  { label: 'Claude: editar o roteiro inteiro…', run: () => app.panel.editPrompt('all') },
  { label: 'Claude: aceitar todas as alterações', run: () => acceptAll(app.view) },
  { label: 'Claude: rejeitar todas as alterações', run: () => rejectAll(app.view) },
  { label: 'Claude: revisar português desta cena', key: 'Ctrl+Shift+G', run: () => app.panel.grammar('scene') },
  { label: 'Claude: revisar português do roteiro inteiro', run: () => app.panel.grammar('all') },
  { label: 'Claude: analisar esta cena', run: () => { togglePanel('notas'); app.panel.analyzeScene(); } },
  { label: 'Claude: análise completa do roteiro', run: () => { togglePanel('notas'); app.panel.analyzeAll(); } },
  { label: 'Claude: listas de produção (decupagem)', run: () => { togglePanel('listas'); app.panel.makeBreakdown(); } },
  { label: 'Claude: plano de filmagem', run: () => togglePanel('plano') },
  { label: 'Claude: conversar sobre o roteiro', key: 'Ctrl+Shift+L', run: () => { document.body.classList.add('panel-open'); app.panel.focusChat(); } },
  { label: 'Painel do Claude', key: 'Ctrl+J', run: () => togglePanel() },
  { label: 'Listas (cenas, personagens, locações)', run: () => togglePanel('listas') },
  { label: `Claude em tempo real: ${app.settings.claude.realtime ? 'desligar' : 'ligar'}`, run: () => updateSettings({ claude: { realtime: !app.settings.claude.realtime } }) },
  { label: 'Buscar e substituir', key: 'Ctrl+F', run: () => openSearchPanel(app.view) },
  { label: 'Histórico de versões', run: showHistory },
  { label: 'Sincronizar com a nuvem agora', run: async () => { await saveNow({ snapshot: true }); await pushCloud(); toast(app.cloud.state === 'synced' ? 'Sincronizado.' : app.cloud.state === 'off' ? 'Nuvem não configurada.' : `Nuvem: ${app.cloud.error}`, { error: app.cloud.state === 'error' }); } },
  { label: 'Modo foco', key: 'Ctrl+Shift+F11', run: toggleFocus },
  ...(platform.mode === 'desktop' ? [{ label: 'Tela cheia', key: 'F11', run: () => call('window.fullscreen') }] : []),
  { label: `Tema: ${{ auto: 'automático', light: 'claro', dark: 'escuro' }[app.settings.theme]} → ${{ auto: 'claro', light: 'escuro', dark: 'automático' }[app.settings.theme]}`, run: () => updateSettings({ theme: { auto: 'light', light: 'dark', dark: 'auto' }[app.settings.theme] }) },
  { label: 'Configurações', key: 'Ctrl+,', run: openSettings },
  { label: 'Atalhos e formato Fountain', key: 'F1', run: showHelp },
];

// Paleta de comandos minimalista
function palette(items = COMMANDS(), placeholderText = 'Comando…') {
  document.querySelector('.palette-back')?.remove();
  const input = h('input', { type: 'text', placeholder: placeholderText, 'aria-label': 'Comando' });
  const list = h('ul', {});
  const back = h('div', { class: 'palette-back', onmousedown: (e) => { if (e.target === back) close(); } }, h('div', { class: 'palette' }, input, list));
  let sel = 0;
  let filtered = items;
  const norm = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const score = (label, q) => {
    const L = norm(label), Q = norm(q);
    if (!Q) return 1;
    if (L.includes(Q)) return 100 - L.indexOf(Q);
    let i = 0; for (const ch of Q) { i = L.indexOf(ch, i); if (i < 0) return 0; i++; }
    return 1;
  };
  const draw = () => {
    const q = input.value.trim();
    filtered = items.map((c) => ({ c, s: score(c.label, q) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.c);
    sel = Math.min(sel, Math.max(0, filtered.length - 1));
    list.replaceChildren(...filtered.map((c, i) => h('li', { class: i === sel ? 'sel' : '', onmousedown: (e) => { e.preventDefault(); pick(c); } }, h('span', {}, c.label), c.key ? h('kbd', {}, c.key) : null)));
    list.children[sel]?.scrollIntoView({ block: 'nearest' });
  };
  const close = () => { back.remove(); app.view.focus(); };
  const pick = (c) => { close(); setTimeout(() => c.run(), 0); };
  input.addEventListener('input', () => { sel = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(filtered.length - 1, sel + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') { if (filtered[sel]) pick(filtered[sel]); e.preventDefault(); }
    else if (e.key === 'Escape') { close(); e.preventDefault(); }
  });
  document.body.append(back);
  draw();
  input.focus();
}

// ---------------------------------------------------------------------------
// Configurações

function openSettings() {
  const s = structuredClone(app.settings);
  const sel = (label, path, options) => h('label', { class: 'field' }, h('span', {}, label),
    h('select', { onchange: (e) => set(path, e.target.value) }, options.map(([v, l]) => h('option', { value: v, selected: get(path) === v }, l))));
  const chk = (label, path, hint) => h('label', { class: 'check', title: hint || '' }, h('input', { type: 'checkbox', checked: !!get(path), onchange: (e) => set(path, e.target.checked) }), label);
  const txt = (label, path, attrs = {}) => h('label', { class: 'field' }, h('span', {}, label), h('input', { type: 'text', value: get(path) ?? '', oninput: (e) => set(path, attrs.type === 'number' ? Number(e.target.value) : e.target.value), ...attrs }));
  function get(p) { return p.split('.').reduce((o, k) => o?.[k], s); }
  function set(p, v) { const ks = p.split('.'); let o = s; for (const k of ks.slice(0, -1)) o = o[k]; o[ks.at(-1)] = v; if (p === 'cloud.provider') drawCloud(); if (p === 'claude.provider') drawClaude(); }

  const claudeBox = h('div', {});
  function drawClaude() {
    claudeBox.replaceChildren(...(s.claude.provider === 'api' ? [
      txt('Chave da API da Anthropic', 'claude.apiKey', { type: 'password', placeholder: s.claude.hasApiKey ? '•••••••• (configurada)' : 'sk-ant-…' }),
      h('p', { class: 'muted small' }, 'Crie em console.anthropic.com. Cobrança por uso, separada da assinatura. A chave fica neste computador', platform.mode === 'desktop' ? ', criptografada pelo chaveiro do sistema.' : '.'),
    ] : [
      h('p', { class: 'muted small' }, 'Usa o Claude Code instalado neste computador, com a sua conta Pro ou Max: sem chave e sem cobrança extra, dentro dos limites do seu plano. Para instalar: npm install -g @anthropic-ai/claude-code, depois rode "claude" no terminal e entre com sua conta.'),
      txt('Caminho do Claude Code (opcional)', 'claude.cliPath', { placeholder: 'encontrado automaticamente' }),
    ]));
  }
  drawClaude();
  const cloudBox = h('div', {});
  function drawCloud() {
    const p = s.cloud.provider;
    cloudBox.replaceChildren(...[
      p === 'webdav' ? h('div', {},
        txt('Endereço WebDAV da pasta', 'cloud.webdav.url', { placeholder: 'https://nuvem.exemplo.com/remote.php/dav/files/usuario/Roteiros/' }),
        txt('Usuário', 'cloud.webdav.username'),
        txt('Senha ou senha de aplicativo', 'cloud.webdav.password', { type: 'password', placeholder: s.cloud.webdav.hasPassword ? '•••••••• (guardada)' : '' }),
        h('p', { class: 'muted small' }, 'Funciona com Nextcloud, ownCloud, Box, Koofr, pCloud (WebDAV), 4shared, servidores próprios. Cada salvamento é enviado em segundos; conflitos entre dispositivos nunca apagam texto.')) : null,
      p === 'folder' ? h('div', {},
        h('div', { class: 'row' }, txt('Pasta sincronizada', 'cloud.folder', { placeholder: '~/Dropbox/Roteiros' }),
          platform.mode === 'desktop' ? h('button', { onclick: async () => { const r = await call('dialog.pickFolder'); if (r) { set('cloud.folder', r.path); drawCloud(); } } }, 'Escolher…') : null),
        h('p', { class: 'muted small' }, 'Use a pasta do Dropbox, Google Drive (Insync, rclone mount), OneDrive (onedriver), MEGA ou Syncthing. O Cena grava uma cópia a cada alteração; o cliente da nuvem envia.')) : null,
      p !== 'none' ? h('div', { class: 'row' }, h('button', { onclick: async (e) => {
        e.target.disabled = true;
        try { const r = await call('cloud.test', { cfg: s.cloud }); toast(r.created ? 'Conectado. A pasta remota foi criada.' : 'Conexão funcionando.'); } catch (err) { toast(`Falhou: ${err.message}`, { error: true }); }
        e.target.disabled = false;
      } }, 'Testar conexão')) : null].filter(Boolean));
  }
  drawCloud();

  const body = h('div', { class: 'settings' },
    h('section', {}, h('h3', {}, 'Geral'),
      sel('Idioma do roteiro e do dicionário', 'lang', [['pt-BR', 'Português (Brasil)'], ['en-US', 'English (US)']]),
      sel('Papel', 'paper', [['a4', 'A4'], ['letter', 'Carta (EUA)']]),
      sel('Tema', 'theme', [['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Escuro']]),
      sel('Fonte do PDF', 'font', [['courier-prime', 'Courier Prime'], ['courier', 'Courier']]),
      chk('Numerar cenas no PDF', 'sceneNumbers'), chk('Cabeçalhos de cena em negrito', 'boldScenes')),
    h('section', {}, h('h3', {}, 'Correção'),
      chk('Verificar ortografia', 'spellcheck'),
      chk('Corrigir acentos automaticamente (voce → você)', 'autocorrect.accents'),
      chk('Maiúscula automática no início das frases', 'autocorrect.capitalize'),
      chk('Formatar elementos automaticamente (maiúsculas, cabeçalhos, extensões)', 'autocorrect.elements'),
      chk('Verificação gramatical contínua com LanguageTool', 'languagetool.enabled', 'Envia os parágrafos ao servidor LanguageTool configurado'),
      txt('Servidor LanguageTool', 'languagetool.url', { placeholder: 'http://localhost:8081/v2/check' }),
      h('p', { class: 'muted small' }, 'O servidor público recebe o texto do roteiro. Para manter tudo local: docker run -p 8081:8010 erikvl87/languagetool. Revisões com o Claude estão sempre disponíveis pelo Ctrl+Shift+G.'),
      s.userWords.length ? h('p', { class: 'muted small' }, `Dicionário pessoal: ${s.userWords.length} palavra(s).`) : null),
    h('section', {}, h('h3', {}, 'Claude'),
      sel('Usar o Claude por', 'claude.provider', [['subscription', 'Minha assinatura (Claude Code)'], ['api', 'Chave da API (cobrança por uso)']]),
      claudeBox,
      sel('Modelo', 'claude.model', DEFAULT_MODEL_LIST),
      chk('Análise em tempo real da cena em que você está', 'claude.realtime'),
      chk('Aplicar as edições do Claude direto no texto, sem revisão (Ctrl+Z desfaz)', 'claude.directEdits'),
      txt('Segundos sem digitar antes de analisar', 'claude.idleSeconds', { type: 'number', min: 5, max: 300 }),
      h('div', { class: 'row' }, h('button', { onclick: async (e) => {
        e.target.disabled = true; e.target.textContent = 'Testando…';
        try {
          await call('settings.set', { patch: { claude: { provider: s.claude.provider, cliPath: s.claude.cliPath, apiKey: s.claude.apiKey } } });
          const r = await call('claude.check');
          toast(`Claude funcionando (${r.via}).`);
        } catch (err) { toast(err.message, { error: true, ms: 9000 }); }
        e.target.disabled = false; e.target.textContent = 'Testar o Claude';
      } }, 'Testar o Claude'))),
    h('section', {}, h('h3', {}, 'Nuvem'),
      sel('Salvamento automático na nuvem', 'cloud.provider', [['none', 'Desativado (só neste computador)'], ['webdav', 'WebDAV / Nextcloud'], ['folder', 'Pasta sincronizada']]),
      cloudBox),
    h('div', { class: 'row end full' },
      h('button', { onclick: () => m.close() }, 'Cancelar'),
      h('button', { class: 'primary', onclick: async () => {
        const patch = structuredClone(s);
        delete patch.recent; delete patch.userWords;
        await updateSettings(patch);
        m.close();
        if (app.settings.cloud.provider !== 'none') checkCloud(); else { app.cloud.state = 'off'; updateStatus(); }
        toast('Configurações salvas.');
      } }, 'Salvar')));
  const m = modal('Configurações', body, { wide: true });
}

// ---------------------------------------------------------------------------
// Atalhos globais

function bindKeys() {
  const map = {
    'ctrl+k': () => palette(), 'ctrl+shift+p': () => palette(),
    'ctrl+n': () => newDoc(), 'ctrl+o': openDialog, 'ctrl+shift+s': saveCopyAs,
    'ctrl+s': async () => { await saveNow({ snapshot: true }); await pushCloud(); toast('Salvo. (O Cena salva sozinho — não precisa de Ctrl+S.)', { ms: 1800 }); },
    'ctrl+e': () => exportAs('pdf'), 'ctrl+g': goToScene, 'ctrl+j': () => togglePanel(),
    'ctrl+shift+l': () => { document.body.classList.add('panel-open'); app.panel.focusChat(); },
    'ctrl+shift+g': () => app.panel.grammar('scene'), 'ctrl+shift+i': fixAllFormatting,
    'ctrl+shift+e': () => app.panel.editPrompt('auto'),
    'ctrl+,': openSettings, 'f1': showHelp, 'ctrl+shift+f11': toggleFocus,
    'f11': () => (platform.mode === 'desktop' ? call('window.fullscreen') : document.documentElement.requestFullscreen?.()),
  };
  addEventListener('keydown', (e) => {
    const k = `${e.ctrlKey || e.metaKey ? 'ctrl+' : ''}${e.shiftKey ? 'shift+' : ''}${e.altKey ? 'alt+' : ''}${e.key.toLowerCase()}`;
    const fn = map[k];
    if (fn && !document.querySelector('.modal-back, .palette-back')) { e.preventDefault(); fn(); }
  }, true);
  $('#docname').addEventListener('click', renameDoc);
  $('#hint-k').addEventListener('click', () => palette());
  $('#status').addEventListener('click', () => palette());
}

init().catch((e) => { document.body.textContent = `Erro ao iniciar: ${e.message}`; console.error(e); });

// para testes automatizados
window.__cena = app;
