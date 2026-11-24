// Painel lateral do Claude: notas em tempo real, listas de produção, plano de filmagem e conversa.
import { h, toast, toCSV, miniMarkdown } from './ui.js';
import { call, newId, saveBytes, textToBase64 } from './platform.js';
import { stats } from '../core/stats.js';
import { formatEighths } from '../core/paginate.js';
import { currentScene, goTo, applyClaudeCorrections, proposeEdits } from './editor.js';
import { modal } from './ui.js';

const KIND = { estrutura: 'Estrutura', personagem: 'Personagem', dialogo: 'Diálogo', ritmo: 'Ritmo', continuidade: 'Continuidade', formatacao: 'Formatação', gramatica: 'Português', producao: 'Produção' };
const SEV = { info: '·', sugestao: '○', problema: '●' };

const BD_CATS = [
  ['cast', 'Elenco'], ['extras', 'Figuração'], ['props', 'Objetos de cena'], ['wardrobe', 'Figurino'], ['makeup', 'Maquiagem e cabelo'],
  ['set_dressing', 'Arte / cenografia'], ['vehicles', 'Veículos'], ['animals', 'Animais'], ['sfx', 'Efeitos especiais'], ['vfx', 'Efeitos visuais'],
  ['sound', 'Som e música'], ['stunts', 'Dublês'],
];

export function createClaudePanel({ root, getView, getDoc, getSettings, onStatus }) {
  const state = {
    tab: 'notas',
    notes: [], summary: '', notesFor: null, analyzing: false, lastSceneHash: null, lastEdit: 0,
    breakdown: null, schedule: null, chat: [], busy: {},
    production: {},
  };
  const running = new Map();

  const tabs = h('nav', { class: 'tabs' });
  const body = h('div', { class: 'panel-body' });
  root.replaceChildren(tabs, body);

  function setTab(t) { state.tab = t; render(); }
  function hasKey() { return getSettings().claude.ready; }

  // -------------------------------------------------------------------------
  async function run(name, args, key, onEvent) {
    if (!hasKey()) { toast('Configure o Claude em Configurações (Ctrl+,): assinatura ou chave da API.', { error: true }); return null; }
    const id = newId();
    running.set(key, id);
    state.busy[key] = true; render();
    try {
      return await call(name, args, onEvent, id);
    } catch (e) {
      if (e.code !== 'aborted') toast(e.message, { error: true, ms: 6000 });
      return null;
    } finally {
      running.delete(key);
      state.busy[key] = false; render();
    }
  }
  function cancel(key) { const id = running.get(key); if (id) call('call.cancel', { id }); }

  // -------------------------------------------------------------------------
  // Notas (análise em tempo real)

  const hash = (s) => { let x = 0; for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0; return x; };

  async function analyzeScene({ auto = false } = {}) {
    const view = getView();
    const sc = currentScene(view);
    if (sc.index < 0 || sc.text.trim().length < 60) { if (!auto) toast('Posicione o cursor numa cena com algum texto.'); return; }
    const hsh = hash(sc.text);
    if (auto && hsh === state.lastSceneHash) return;
    state.lastSceneHash = hsh;
    state.analyzing = true; onStatus?.('Claude lendo a cena…'); render();
    const st = stats(getDoc().text);
    const number = st.scenes[sc.index]?.number;
    const res = await run('claude.analyze', { text: getDoc().text, scope: 'scene', sceneText: sc.text, sceneNumber: number }, 'notes');
    state.analyzing = false;
    if (res) {
      state.notes = res.data.notes.map((n) => ({ ...n, scene: n.scene || number }));
      state.summary = res.data.summary;
      state.notesFor = `Cena ${number}`;
      onStatus?.(state.notes.length ? `Claude: ${state.notes.length} nota${state.notes.length > 1 ? 's' : ''}` : 'Claude: sem notas');
    } else onStatus?.('');
    render();
  }

  async function analyzeAll() {
    state.analyzing = true; render();
    const res = await run('claude.analyze', { text: getDoc().text, scope: 'full' }, 'notes');
    state.analyzing = false;
    if (res) { state.notes = res.data.notes; state.summary = res.data.summary; state.notesFor = 'Roteiro completo'; setTab('notas'); }
    render();
  }

  // chamado pelo app a cada edição: agenda a análise em tempo real da cena atual
  function onEdit() {
    const s = getSettings();
    if (s.claude.realtime && hasKey()) scheduleRealtimeWith((s.claude.idleSeconds || 20) * 1000);
  }
  let rtTimer;
  function scheduleRealtimeWith(ms) {
    clearTimeout(rtTimer);
    rtTimer = setTimeout(() => {
      const s = getSettings();
      if (!s.claude.realtime || !hasKey() || state.busy.notes) return;
      analyzeScene({ auto: true });
    }, ms);
  }

  function jumpToQuote(q) {
    const view = getView();
    const text = view.state.doc.toString();
    let idx = q ? text.indexOf(q) : -1;
    if (idx === -1 && q) idx = text.toLowerCase().indexOf(q.toLowerCase().slice(0, 40));
    if (idx === -1) { toast('Trecho não encontrado (o texto mudou?).'); return; }
    goTo(view, idx, { select: q.length });
  }

  function renderNotes() {
    const s = getSettings();
    const head = h('div', { class: 'row' },
      h('label', { class: 'check', title: 'Analisa a cena em que você está depois de alguns segundos sem digitar' },
        h('input', { type: 'checkbox', checked: s.claude.realtime, onchange: (e) => root.dispatchEvent(new CustomEvent('setting', { detail: { claude: { realtime: e.target.checked } } })) }),
        'Tempo real'),
      h('span', { class: 'grow' }),
      h('button', { onclick: () => analyzeScene(), disabled: state.busy.notes }, 'Esta cena'),
      h('button', { onclick: analyzeAll, disabled: state.busy.notes }, 'Roteiro todo'));
    const list = h('div', { class: 'notes' });
    if (state.busy.notes) list.append(h('p', { class: 'muted pulse' }, 'Lendo… ', h('button', { class: 'link', onclick: () => cancel('notes') }, 'cancelar')));
    if (!hasKey()) list.append(h('p', { class: 'muted' }, 'Configure o Claude em Configurações (Ctrl+,) para ativar a análise.'));
    if (state.notesFor) list.append(h('p', { class: 'muted small' }, state.notesFor));
    if (state.summary) list.append(h('p', { class: 'summary' }, state.summary));
    for (const n of state.notes) {
      list.append(h('article', { class: `note sev-${n.severity}`, onclick: () => jumpToQuote(n.quote), title: 'Ir para o trecho' },
        h('div', { class: 'meta' }, `${SEV[n.severity] || ''} ${KIND[n.kind] || n.kind}${n.scene ? ` · cena ${n.scene}` : ''}`),
        h('p', {}, n.note),
        n.suggestion ? h('p', { class: 'sugg' }, n.suggestion) : null));
    }
    if (!state.notes.length && state.notesFor && !state.busy.notes) list.append(h('p', { class: 'muted' }, 'Nada a apontar.'));
    return [head, list];
  }

  // -------------------------------------------------------------------------
  // Revisão gramatical com o Claude

  async function grammar(scope = 'scene') {
    const view = getView();
    let ranges;
    if (scope === 'scene') {
      const sc = currentScene(view);
      ranges = [{ from: sc.from, to: sc.to }];
    } else {
      // documento em blocos de ~6 mil caracteres, quebrando entre parágrafos
      ranges = [];
      const text = view.state.doc.toString();
      let start = 0;
      while (start < text.length) {
        let end = Math.min(text.length, start + 6000);
        if (end < text.length) { const nb = text.lastIndexOf('\n\n', end); if (nb > start + 1000) end = nb; }
        ranges.push({ from: start, to: end });
        start = end;
      }
    }
    let total = 0;
    onStatus?.('Claude revisando o português…');
    for (const [i, r] of ranges.entries()) {
      if (ranges.length > 1) onStatus?.(`Claude revisando… ${i + 1}/${ranges.length}`);
      const passage = view.state.doc.sliceString(r.from, r.to);
      if (!passage.trim()) continue;
      const res = await run('claude.grammar', { passage }, 'grammar');
      if (!res) break;
      total += applyClaudeCorrections(view, res.data.corrections, r.from, r.to);
    }
    onStatus?.('');
    toast(total ? `${total} correç${total > 1 ? 'ões sugeridas' : 'ão sugerida'} — sublinhadas no texto.` : 'Nenhum erro encontrado.');
  }

  // -------------------------------------------------------------------------
  // Listas de produção

  async function makeBreakdown() {
    let chars = 0;
    const res = await run('claude.breakdown', { text: getDoc().text }, 'breakdown', (ev) => { if (ev.type === 'progress') { chars += ev.chars; onStatus?.(`Claude decupando… ${Math.round(chars / 100) / 10}k`); } });
    onStatus?.('');
    if (res) { state.breakdown = { ...res.data, at: Date.now() }; await saveProduction(); render(); toast('Decupagem pronta.'); }
  }

  function localLists() {
    const st = stats(getDoc().text, { paper: getSettings().paper, lang: getSettings().lang });
    return st;
  }

  let listView = 'cenas';
  function renderLists() {
    const st = localLists();
    const views = [['cenas', 'Cenas'], ['personagens', 'Personagens'], ['locacoes', 'Locações'], ...(state.breakdown ? [['decupagem', 'Decupagem'], ...BD_CATS.map(([k, l]) => [`bd:${k}`, l])] : [])];
    const sel = h('select', { onchange: (e) => { listView = e.target.value; render(); } }, views.map(([v, l]) => h('option', { value: v, selected: v === listView }, l)));
    const head = h('div', { class: 'row' }, sel, h('span', { class: 'grow' }),
      state.busy.breakdown ? h('button', { onclick: () => cancel('breakdown') }, 'Cancelar') : h('button', { onclick: makeBreakdown, title: 'Elenco, objetos, figurino, efeitos… por cena' }, state.breakdown ? 'Refazer decupagem' : 'Decupar com Claude'));
    const { columns, rows, title } = listTable(st, listView);
    const table = tableEl(columns, rows, (r) => r.__line != null && goTo(getView(), getView().state.doc.line(r.__line + 1).from));
    const exp = h('div', { class: 'row end' },
      h('button', { onclick: () => exportCSV(title, columns, rows) }, 'CSV'),
      h('button', { onclick: () => exportPDF(title, columns, rows) }, 'PDF'));
    return [head, state.busy.breakdown ? h('p', { class: 'muted pulse' }, 'Decupando o roteiro inteiro… isso leva um ou dois minutos.') : null,
      h('p', { class: 'muted small' }, `${st.pages} pág. · ~${st.minutes} min · ${st.scenes.length} cenas · ${st.characters.length} personagens`), table, exp];
  }

  function listTable(st, v) {
    if (v === 'cenas') {
      return { title: 'Cenas', columns: [{ key: 'number', label: '#', weight: 0.4 }, { key: 'heading', label: 'Cabeçalho', weight: 3 }, { key: 'pages', label: 'Pág.', weight: 0.6 }, { key: 'cast', label: 'Elenco', weight: 2.5 }],
        rows: st.scenes.map((s) => ({ number: s.number, heading: s.heading, pages: s.pages, cast: s.characters.join(', '), __line: s.line })) };
    }
    if (v === 'personagens') {
      return { title: 'Personagens', columns: [{ key: 'name', label: 'Personagem', weight: 2 }, { key: 'speeches', label: 'Falas' }, { key: 'scenes', label: 'Cenas' }, { key: 'pages', label: 'Páginas' }, ...(state.breakdown ? [{ key: 'desc', label: 'Descrição', weight: 3 }] : [])],
        rows: st.characters.map((c) => ({ name: c.name, speeches: c.speeches, scenes: c.scenes, pages: formatEighths(c.eighths), desc: state.breakdown?.cast.find((x) => x.name.toUpperCase() === c.name)?.description || '' })) };
    }
    if (v === 'locacoes') {
      const m = new Map();
      for (const s of st.scenes) { const k = s.location || '(sem locação)'; const cur = m.get(k) || { location: k, scenes: [], eighths: 0, times: new Set(), ie: new Set() }; cur.scenes.push(s.number); cur.eighths += s.eighths; if (s.time) cur.times.add(s.time); if (s.intExt) cur.ie.add(s.intExt); m.set(k, cur); }
      return { title: 'Locações', columns: [{ key: 'location', label: 'Locação', weight: 2.5 }, { key: 'ie', label: 'Int/Ext' }, { key: 'times', label: 'Períodos', weight: 1.5 }, { key: 'scenes', label: 'Cenas', weight: 1.5 }, { key: 'pages', label: 'Páginas' }],
        rows: [...m.values()].map((x) => ({ location: x.location, ie: [...x.ie].join('/'), times: [...x.times].join(', '), scenes: x.scenes.join(', '), pages: formatEighths(x.eighths) })) };
    }
    if (v === 'decupagem') {
      const cols = [{ key: 'number', label: '#', weight: 0.4 }, { key: 'heading', label: 'Cena', weight: 2 }, ...BD_CATS.slice(0, 6).map(([k, l]) => ({ key: k, label: l })), { key: 'other', label: 'Outros', weight: 1.4 }, { key: 'notes', label: 'Obs.', weight: 1.4 }];
      const byNum = new Map(st.scenes.map((s) => [String(s.number), s]));
      return { title: 'Decupagem', columns: cols,
        rows: state.breakdown.scenes.map((b) => ({ ...Object.fromEntries(BD_CATS.map(([k]) => [k, (b[k] || []).join(', ')])), number: b.number, heading: byNum.get(String(b.number))?.heading || '', other: BD_CATS.slice(6).flatMap(([k, l]) => (b[k] || []).length ? [`${l}: ${b[k].join(', ')}`] : []).join(' · '), notes: b.notes, __line: byNum.get(String(b.number))?.line })) };
    }
    const cat = v.slice(3);
    const label = BD_CATS.find(([k]) => k === cat)[1];
    const m = new Map();
    for (const b of state.breakdown.scenes) for (const item of b[cat] || []) { const k = item.trim(); const cur = m.get(k.toLowerCase()) || { item: k, scenes: [] }; cur.scenes.push(b.number); m.set(k.toLowerCase(), cur); }
    return { title: label, columns: [{ key: 'item', label, weight: 3 }, { key: 'scenes', label: 'Cenas', weight: 1.5 }],
      rows: [...m.values()].sort((a, b) => a.item.localeCompare(b.item, 'pt-BR')).map((x) => ({ item: x.item, scenes: x.scenes.join(', ') })) };
  }

  function tableEl(columns, rows, onRow) {
    return h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, columns.map((c) => h('th', {}, c.label)))),
      h('tbody', {}, rows.map((r) => r.__section
        ? h('tr', { class: 'section' }, h('td', { colspan: columns.length }, r.__section))
        : h('tr', { onclick: () => onRow?.(r), class: r.__line != null ? 'clickable' : '' }, columns.map((c) => h('td', {}, String(r[c.key] ?? ''))))))));
  }

  const docBase = () => (getDoc().name || 'roteiro').replace(/\.fountain$/i, '');
  async function exportCSV(title, columns, rows) {
    const r = await saveBytes(`${docBase()} - ${title}.csv`, textToBase64(toCSV(columns, rows)), 'csv', 'text/csv');
    if (r) toast(`Exportado: ${r.path}`);
  }
  async function exportPDF(title, columns, rows, subtitle) {
    try {
      const out = await call('export.table', { title: `${docBase()} — ${title}`, subtitle: subtitle || `Gerado pelo Cena em ${new Date().toLocaleDateString('pt-BR')}`, columns, rows });
      const r = await saveBytes(`${docBase()} - ${title}.pdf`, out.base64, 'pdf', out.mime);
      if (r) toast(`Exportado: ${r.path}`);
    } catch (e) { toast(e.message, { error: true }); }
  }

  // -------------------------------------------------------------------------
  // Plano de filmagem

  const schedParams = { startDate: '', pagesPerDay: 4, hoursPerDay: 10, callTime: '07:00', daysOff: 'domingos', notes: '' };
  async function makeSchedule() {
    let chars = 0;
    const res = await run('claude.schedule', { text: getDoc().text, params: schedParams }, 'schedule', (ev) => { if (ev.type === 'progress') { chars += ev.chars; onStatus?.(`Claude montando o plano… ${Math.round(chars / 100) / 10}k`); } });
    onStatus?.('');
    if (res) { state.schedule = { ...res.data, params: { ...schedParams }, at: Date.now() }; await saveProduction(); render(); toast('Plano de filmagem pronto.'); }
  }

  function scheduleRows() {
    const rows = [];
    for (const d of state.schedule.days) {
      rows.push({ __section: `Diária ${d.day}${d.date ? ` — ${d.date}` : ''} · ${d.unit} · ${formatEighths(d.eighths || 0)} pág.${d.call_time ? ` · chamada ${d.call_time}` : ''}${d.wrap_time ? ` · fim ${d.wrap_time}` : ''}` });
      for (const s of d.scenes) rows.push({ number: s.number, heading: s.heading, ie: s.intExt, time: s.time, pages: s.pages, cast: s.cast.join(', '), notes: s.notes });
      if (d.notes) rows.push({ number: '', heading: `Obs.: ${d.notes}` });
    }
    return rows;
  }
  const schedCols = [{ key: 'number', label: '#', weight: 0.4 }, { key: 'heading', label: 'Cena', weight: 3 }, { key: 'pages', label: 'Pág.', weight: 0.6 }, { key: 'cast', label: 'Elenco', weight: 2 }, { key: 'notes', label: 'Obs.', weight: 2 }];

  function renderSchedule() {
    const field = (label, key, type = 'text', attrs = {}) => h('label', { class: 'field' }, h('span', {}, label),
      h('input', { type, value: schedParams[key], oninput: (e) => { schedParams[key] = type === 'number' ? Number(e.target.value) : e.target.value; }, ...attrs }));
    const form = h('div', { class: 'form-grid' },
      field('Início', 'startDate', 'date'), field('Páginas/diária', 'pagesPerDay', 'number', { min: 1, max: 12, step: 0.5 }),
      field('Horas/diária', 'hoursPerDay', 'number', { min: 4, max: 16 }), field('Chamada', 'callTime', 'time'),
      field('Folgas', 'daysOff'), field('Observações', 'notes', 'text', { placeholder: 'ex.: atriz só disponível na 2ª semana' }));
    const out = [h('details', { open: !state.schedule }, h('summary', {}, 'Parâmetros'), form),
      h('div', { class: 'row end' }, state.busy.schedule ? h('button', { onclick: () => cancel('schedule') }, 'Cancelar') : h('button', { class: 'primary', onclick: makeSchedule }, state.schedule ? 'Refazer plano' : 'Gerar plano com Claude'))];
    if (state.busy.schedule) out.push(h('p', { class: 'muted pulse' }, 'Montando as diárias… isso leva alguns minutos em roteiros longos.'));
    if (state.schedule) {
      const sc = state.schedule;
      const total = sc.days.reduce((n, d) => n + (d.eighths || 0), 0);
      out.push(h('p', { class: 'muted small' }, `${sc.days.length} diárias · ${formatEighths(total)} páginas`));
      for (const d of sc.days) {
        out.push(h('section', { class: 'day' },
          h('h3', {}, `Diária ${d.day}`, h('span', { class: 'muted' }, ` ${d.date || ''} · ${formatEighths(d.eighths || 0)} pág.`)),
          h('p', { class: 'small' }, d.unit, d.call_time ? ` · chamada ${d.call_time}` : '', d.wrap_time ? ` · fim ${d.wrap_time}` : ''),
          h('ul', {}, d.scenes.map((s) => h('li', { onclick: () => { const st = localLists(); const x = st.scenes.find((y) => String(y.number) === String(s.number)); if (x) goTo(getView(), getView().state.doc.line(x.line + 1).from); } },
            h('b', {}, `${s.number} `), s.heading || '', h('span', { class: 'muted' }, ` · ${s.pages || ''} · ${s.cast.join(', ')}`), s.notes ? h('div', { class: 'muted small' }, s.notes) : null))),
          d.notes ? h('p', { class: 'muted small' }, d.notes) : null));
      }
      if (sc.warnings?.length) out.push(h('div', { class: 'warnings' }, h('h3', {}, 'Atenção'), h('ul', {}, sc.warnings.map((w) => h('li', {}, w)))));
      if (sc.rationale) out.push(h('details', {}, h('summary', {}, 'Por que esta ordem'), h('p', { class: 'small' }, sc.rationale)));
      out.push(h('div', { class: 'row end' },
        h('button', { onclick: () => exportCSV('Plano de filmagem', schedCols, scheduleRows()) }, 'CSV'),
        h('button', { onclick: () => exportPDF('Plano de filmagem', schedCols, scheduleRows(), `${sc.days.length} diárias · ${formatEighths(total)} páginas`) }, 'PDF')));
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Conversa

  let chatInput;
  // -------------------------------------------------------------------------
  // Edição do texto pelo Claude

  /** Escopo da edição: seleção, cena atual ou roteiro inteiro. */
  // kind: 'auto' (seleção, senão cena atual, senão tudo), 'scene' ou 'all'
  function editScope(kind) {
    const view = getView();
    const sel = view.state.selection.main;
    if (kind === 'auto' && !sel.empty) return { from: sel.from, to: sel.to, label: `o trecho selecionado (${sel.to - sel.from} caracteres)` };
    if (kind !== 'all') {
      const sc = currentScene(view);
      if (sc.index >= 0) return { from: sc.from, to: sc.to, label: `a cena ${sc.index + 1}` };
    }
    return { from: 0, to: view.state.doc.length, label: 'o roteiro inteiro' };
  }

  /** Pede a alteração e mostra (ou aplica) as substituições. Retorna o resumo. */
  async function editText(instruction, kind = 'auto', history = []) {
    const view = getView();
    const scope = editScope(kind);
    const text = view.state.doc.toString();
    const docAtStart = view.state.doc;
    let chars = 0;
    onStatus?.('Claude editando…');
    const res = await run('claude.edit', {
      text, instruction, history,
      scopeText: scope.from === 0 && scope.to === text.length ? null : text.slice(scope.from, scope.to),
      scopeLabel: scope.label,
    }, 'edit', (ev) => { if (ev.type === 'progress') { chars += ev.chars; onStatus?.(`Claude editando… ${Math.round(chars / 100) / 10}k`); } });
    onStatus?.('');
    if (!res) return null;
    const { summary, edits } = res.data;
    // se o autor digitou enquanto o Claude trabalhava, procura no documento inteiro
    const sameDoc = view.state.doc === docAtStart;
    const direct = !!getSettings().claude.directEdits;
    const r = proposeEdits(view, edits, sameDoc ? scope.from : 0, sameDoc ? scope.to : view.state.doc.length, { direct });
    if (!edits.length) toast(summary || 'O Claude não propôs alterações.', { ms: 6000 });
    else if (direct) toast(`${r.found} alteraç${r.found === 1 ? 'ão aplicada' : 'ões aplicadas'}.${r.missing ? ` ${r.missing} não encontrada(s) no texto.` : ''}`, { action: { label: 'Desfazer', run: () => root.dispatchEvent(new CustomEvent('undo')) } });
    else toast(`${r.found} alteraç${r.found === 1 ? 'ão proposta' : 'ões propostas'} no texto.${r.missing ? ` ${r.missing} não encontrada(s).` : ''}`);
    return { summary, found: r.found, missing: r.missing };
  }

  /** Janela para pedir a alteração. */
  function editPrompt(kind = 'auto') {
    const scope = editScope(kind);
    const input = h('textarea', { rows: 3, placeholder: 'O que mudar? Ex.: deixe o diálogo mais tenso e com menos explicação' });
    const go = () => { const v = input.value.trim(); if (!v) return; m.close(); editText(v, kind); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } });
    const ideas = ['Deixe o diálogo mais natural', 'Corte o que for exposição', 'Reescreva a ação com mais ritmo', 'Mostre em vez de contar', 'Traduza para o inglês', 'Corrija o português e a formatação'];
    const m = modal('Pedir ao Claude para editar', h('div', { class: 'confirm' },
      h('p', { class: 'muted small' }, `Vai editar ${scope.label}. `, getSettings().claude.directEdits ? 'As alterações entram direto no texto (Ctrl+Z desfaz).' : 'As alterações aparecem no texto para você aceitar ou rejeitar.'),
      input,
      h('div', { class: 'chips' }, ideas.map((q) => h('button', { class: 'chip', onclick: () => { input.value = q; input.focus(); } }, q))),
      h('div', { class: 'row end' }, h('button', { onclick: () => m.close() }, 'Cancelar'), h('button', { class: 'primary', onclick: go }, 'Editar'))));
    setTimeout(() => input.focus(), 0);
  }

  let chatEdits = false;
  async function send(text) {
    text = (text || '').trim();
    if (!text || state.busy.chat || state.busy.edit) return;
    if (chatEdits) {
      // conversa em modo edição: o pedido vira alterações no texto
      const history = state.chat.slice(-6).map((m) => ({ role: m.role, content: m.content }));
      state.chat.push({ role: 'user', content: text });
      const reply = { role: 'assistant', content: '…' };
      state.chat.push(reply);
      render();
      const r = await editText(text, 'auto', history);
      if (!r) { state.chat.splice(-2, 2); render(); return; }
      reply.content = `${r.summary}${r.found ? `\n\n*${r.found} alteraç${r.found === 1 ? 'ão' : 'ões'} ${getSettings().claude.directEdits ? 'aplicada' + (r.found === 1 ? '' : 's') : 'no texto para revisar'}.*` : ''}${r.missing ? `\n\n*${r.missing} não encontrada(s) no texto.*` : ''}`;
      render();
      return;
    }
    state.chat.push({ role: 'user', content: text });
    const reply = { role: 'assistant', content: '' };
    state.chat.push(reply);
    render();
    const history = state.chat.slice(0, -1).map((m) => ({ role: m.role, content: m.content }));
    const res = await run('claude.chat', { text: getDoc().text, history }, 'chat', (ev) => {
      if (ev.type === 'text') { reply.content += ev.text; updateLastMessage(reply.content); }
    });
    if (!res && !reply.content) state.chat.splice(-2, 2);
    render();
  }
  function updateLastMessage(md) {
    const last = body.querySelector('.chat .msg.assistant:last-child .content');
    if (last) { last.innerHTML = miniMarkdown(md); last.parentElement.parentElement.scrollTop = 1e9; }
  }
  function renderChat() {
    const msgs = h('div', { class: 'chat' }, state.chat.map((m) => h('div', { class: `msg ${m.role}` }, h('div', { class: 'content', html: m.role === 'assistant' ? miniMarkdown(m.content || '…') : '' }, m.role === 'user' ? m.content : null))));
    if (!state.chat.length) {
      msgs.append(h('div', { class: 'chips' }, [
        'Escreva uma logline para este roteiro', 'Onde o ritmo cai?', 'Os personagens têm vozes distintas?',
        'Sugira um título', 'O que falta para o terceiro ato funcionar?', 'Quanto custaria produzir? Pontos caros.',
      ].map((q) => h('button', { class: 'chip', onclick: () => send(q) }, q))));
    }
    chatInput = h('textarea', {
      rows: 2, placeholder: 'Pergunte sobre o roteiro…', title: 'Enter envia · Shift+Enter quebra a linha',
      onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(chatInput.value); chatInput.value = ''; } },
    });
    const busy = state.busy.chat || state.busy.edit;
    const foot = h('div', { class: 'chat-foot' },
      h('div', { class: 'chat-input' }, chatInput,
        busy ? h('button', { onclick: () => { cancel('chat'); cancel('edit'); } }, 'Parar') : h('button', { class: 'primary', onclick: () => { send(chatInput.value); chatInput.value = ''; } }, 'Enviar')),
      h('div', { class: 'row' },
        h('label', { class: 'check small', title: 'Os pedidos viram alterações no texto (na seleção, na cena atual ou no roteiro inteiro)' },
          h('input', { type: 'checkbox', checked: chatEdits, onchange: (e) => { chatEdits = e.target.checked; render(); } }), 'Editar o texto'),
        h('span', { class: 'grow' }),
        state.chat.length ? h('button', { class: 'link', onclick: () => { state.chat = []; render(); } }, 'limpar') : null));
    if (chatEdits) chatInput.placeholder = 'Peça uma alteração… (seleção, cena atual ou tudo)';
    setTimeout(() => { msgs.scrollTop = 1e9; }, 0);
    return [msgs, foot];
  }

  // -------------------------------------------------------------------------
  // Persistência das listas/plano por documento

  async function loadProduction() {
    state.breakdown = null; state.schedule = null; state.notes = []; state.summary = ''; state.notesFor = null; state.chat = [];
    const doc = getDoc();
    if (!doc.path) return;
    try {
      const p = await call('prod.get', { path: doc.path });
      state.breakdown = p?.breakdown || null; state.schedule = p?.schedule || null;
      if (p?.schedule?.params) Object.assign(schedParams, p.schedule.params);
    } catch { /* sem dados */ }
    render();
  }
  async function saveProduction() {
    const doc = getDoc();
    if (doc.path) await call('prod.set', { path: doc.path, data: { breakdown: state.breakdown, schedule: state.schedule } }).catch(() => {});
  }

  // -------------------------------------------------------------------------
  function render() {
    const focusChat = state.tab === 'conversa' && document.activeElement === chatInput;
    tabs.replaceChildren(...[['notas', 'Notas'], ['listas', 'Listas'], ['plano', 'Plano'], ['conversa', 'Conversa']].map(([k, l]) =>
      h('button', { class: state.tab === k ? 'active' : '', onclick: () => setTab(k) }, l, state.busy[{ notas: 'notes', listas: 'breakdown', plano: 'schedule', conversa: 'chat' }[k]] || (k === 'conversa' && state.busy.edit) ? h('span', { class: 'dot' }) : null)));
    const content = state.tab === 'notas' ? renderNotes() : state.tab === 'listas' ? renderLists() : state.tab === 'plano' ? renderSchedule() : renderChat();
    body.replaceChildren(...content.flat().filter(Boolean));
    body.className = `panel-body tab-${state.tab}`;
    if (focusChat) chatInput.focus();
  }
  render();

  return {
    setTab, render, onEdit, analyzeScene, analyzeAll, grammar, makeBreakdown, makeSchedule, loadProduction, editPrompt, editText,
    focusChat: () => { setTab('conversa'); setTimeout(() => chatInput?.focus(), 0); },
  };
}
