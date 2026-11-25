// Editor de roteiro sobre CodeMirror 6.
// O texto é Fountain puro; a formatação visual vem da classificação de cada linha.
import { EditorState, StateField, StateEffect, Prec, EditorSelection } from '@codemirror/state';
import { EditorView, ViewPlugin, Decoration, WidgetType, keymap, drawSelection, highlightActiveLine, placeholder } from '@codemirror/view';
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands';
import { autocompletion, completionStatus, acceptCompletion, startCompletion } from '@codemirror/autocomplete';
import { linter } from '@codemirror/lint';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import {
  classifyLines, SCENE_RE, parseScene, characterNames, locations, isUpperLine,
  TIMES_PT, TIMES_EN, TRANSITIONS,
} from '../core/fountain.js';
import { fixSceneHeading, fixCharacter, formatWarnings } from '../core/format.js';
import { words as splitWords } from '../core/spell.js';
import { inlineMarkup, elementMarkers, titleKey } from '../core/markup.js';

// ---------------------------------------------------------------------------
// Tipos de linha

// modo 'plain' (bíblia da série, .md): texto corrido, sem elementos de roteiro
function classify(text) {
  if (editorConfig.mode === 'plain') return text.split('\n').map((l) => (/^#{1,6}\s/.test(l) ? 'mdh' : l.trim() ? 'plain' : 'empty'));
  return classifyLines(text);
}
const typesField = StateField.define({
  create: (s) => classify(s.doc.toString()),
  update: (v, tr) => (tr.docChanged ? classify(tr.state.doc.toString()) : v),
});

// Tipo "pendente" de uma linha vazia, escolhido com Tab/Enter antes de digitar
const setPending = StateEffect.define();
const pendingField = StateField.define({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setPending)) return e.value;
    if (!v) return v;
    const pos = tr.changes.mapPos(v.pos, 1);
    const line = tr.state.doc.lineAt(pos);
    const head = tr.state.selection.main.head;
    if (head < line.from || head > line.to) return null; // saiu da linha
    return { pos: line.from, type: v.type };
  },
});

export function lineType(state, lineNo) {
  const t = state.field(typesField)[lineNo - 1] || 'action';
  const p = state.field(pendingField);
  // o elemento escolhido com Tab/Enter prevalece enquanto a linha é ambígua
  if (p && state.doc.lineAt(p.pos).number === lineNo) {
    if (t === 'empty' || t === 'action') return p.type;
    if (t === 'character' && (p.type === 'scene' || p.type === 'transition')) return p.type;
  }
  return t;
}

const LABELS = { character: 'PERSONAGEM', scene: 'INT./EXT. LOCAL - DIA', transition: 'TRANSIÇÃO:', dialogue: 'fala', parenthetical: '(rubrica)', action: 'ação' };

class Hint extends WidgetType {
  constructor(text) { super(); this.text = text; }
  eq(o) { return o.text === this.text; }
  toDOM() { const s = document.createElement('span'); s.className = 'cm-hint'; s.textContent = this.text; return s; }
}

// Números de cena (contagem automática ou #n# explícito), recalculados a cada edição
const sceneNumField = StateField.define({
  create: (s) => sceneNumbers(s),
  update: (v, tr) => (tr.docChanged ? sceneNumbers(tr.state) : v),
});
function sceneNumbers(state) {
  const types = state.field(typesField);
  const nums = new Map();
  let n = 0;
  for (let i = 0; i < types.length; i++) {
    if (types[i] !== 'scene') continue;
    n++;
    const m = state.doc.line(i + 1).text.match(/#([\w.-]+)#\s*$/);
    nums.set(i + 1, m ? m[1] : String(n));
  }
  return nums;
}

// Modo WYSIWYG: fora da linha em edição, as marcações Fountain ficam escondidas
// e a ênfase aparece formatada; na linha do cursor, aparecem esmaecidas para edição.
const TITLE_CENTER = new Set(['title', 'credit', 'author', 'authors', 'source']);
const hidden = Decoration.replace({});
const dimMark = Decoration.mark({ class: 'cm-md' });

function activeLines(state) {
  const set = new Set();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number, b = state.doc.lineAt(r.to).number;
    for (let i = a; i <= b; i++) set.add(i);
  }
  return set;
}

const lineDecorations = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || u.transactions.some((t) => t.effects.some((e) => e.is(setPending)))) this.decorations = this.build(u.view);
  }
  build(view) {
    const { state } = view;
    const decos = [];
    const pending = state.field(pendingField);
    const nums = state.field(sceneNumField);
    const active = view.hasFocus ? activeLines(state) : new Set();
    const wysiwyg = editorConfig.settings.wysiwyg !== false;
    const types = state.field(typesField);
    for (const { from, to } of view.visibleRanges) {
      let pos = from;
      while (pos <= to) {
        const line = state.doc.lineAt(pos);
        const t = lineType(state, line.number);
        const isActive = active.has(line.number);
        const cls = [`ln ln-${t}`];
        const attrs = {};
        let hideRanges = [];
        if (t === 'scene') attrs['data-scene'] = nums.get(line.number) || '';
        if (t === 'title') {
          // a chave da linha (ou da linha anterior, nas continuações recuadas) define o estilo
          let key = null;
          for (let k = line.number; k >= 1 && types[k - 1] === 'title'; k--) {
            const tk = titleKey(state.doc.line(k).text);
            if (tk) { key = tk.key; if (k === line.number) hideRanges.push(tk.hide); break; }
          }
          cls.push(TITLE_CENTER.has(key) ? `tp-center tp-${key}` : ['draft date', 'date', 'notes'].includes(key) ? 'tp-side tp-right' : 'tp-side');
          if (line.number !== 1 && !titleKey(line.text)) { const lead = line.text.length - line.text.trimStart().length; if (lead) hideRanges.push([0, lead]); }
          if (line.number < types.length && types[line.number] !== 'title') cls.push('tp-last');
        }
        decos.push(Decoration.line({ class: cls.join(' '), attributes: attrs }).range(line.from));
        if (pending && line.from === pending.pos && line.length === 0 && LABELS[pending.type]) {
          decos.push(Decoration.widget({ widget: new Hint(LABELS[pending.type]), side: 1 }).range(line.from));
        }
        if (line.length && !['boneyard', 'pagebreak'].includes(t)) {
          hideRanges.push(...elementMarkers(t, line.text));
          const im = inlineMarkup(line.text);
          hideRanges.push(...im.hide);
          for (const [a, b, c] of im.marks) if (b > a) decos.push(Decoration.mark({ class: c }).range(line.from + a, line.from + b));
          hideRanges = mergeRanges(hideRanges);
          for (const [a, b] of hideRanges) {
            if (b <= a) continue;
            decos.push((wysiwyg && !isActive ? hidden : dimMark).range(line.from + a, line.from + b));
          }
        }
        pos = line.to + 1;
      }
    }
    return Decoration.set(decos, true);
  }
}, { decorations: (v) => v.decorations });

function mergeRanges(rs) {
  const s = rs.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const r of s) { const last = out[out.length - 1]; if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else out.push([...r]); }
  return out;
}

// Quebras de página, calculadas pela mesma paginação do PDF
class PageBreak extends WidgetType {
  constructor(page) { super(); this.page = page; }
  eq(o) { return o.page === this.page; }
  toDOM() {
    const d = document.createElement('div');
    d.className = 'cm-pagebreak';
    d.setAttribute('aria-label', `Página ${this.page}`);
    d.innerHTML = `<span>${this.page}.</span>`;
    return d;
  }
  get estimatedHeight() { return 44; }
  ignoreEvent() { return true; }
}
const setPages = StateEffect.define();
const pagesField = StateField.define({
  create: () => Decoration.none,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setPages)) return e.value;
    return tr.docChanged ? v.map(tr.changes) : v;
  },
  provide: (f) => EditorView.decorations.from(f),
});
/** starts: [{ page, line (base 0) }] vindos de pageStarts(); hasTitle: há página de rosto. */
export function setPageBreaks(view, starts, hasTitle) {
  const { doc } = view.state;
  const ranges = [];
  for (const s of starts) {
    if (s.page === 1 && !hasTitle) continue;
    if (s.line + 1 > doc.lines || s.line < 0) continue;
    ranges.push(Decoration.widget({ widget: new PageBreak(s.page), block: true, side: -1 }).range(doc.line(s.line + 1).from));
  }
  view.dispatch({ effects: setPages.of(Decoration.set(ranges, true)) });
}

// Negrito / itálico / sublinhado: envolve (ou desfaz) a seleção com os marcadores Fountain
function toggleWrap(marker) {
  return (view) => {
    const { state } = view;
    const changes = state.changeByRange((r) => {
      const n = marker.length;
      const before = state.sliceDoc(r.from - n, r.from), after = state.sliceDoc(r.to, r.to + n);
      if (before === marker && after === marker) {
        return { changes: [{ from: r.from - n, to: r.from }, { from: r.to, to: r.to + n }], range: EditorSelection.range(r.from - n, r.to - n) };
      }
      return { changes: [{ from: r.from, insert: marker }, { from: r.to, insert: marker }], range: EditorSelection.range(r.from + n, r.to + n) };
    });
    view.dispatch(changes, { userEvent: 'input.format' });
    return true;
  };
}

// ---------------------------------------------------------------------------
// Configuração dinâmica (corretor, preferências, notas do Claude)

export const editorConfig = {
  speller: null,
  userWords: new Set(),
  ignored: new Set(),
  settings: { autocorrect: { accents: true, capitalize: true, elements: true }, spellcheck: true, lang: 'pt-BR' },
  languagetool: null, // async (text) => matches
  onAddWord: null,
};

// Diagnósticos vindos do Claude (revisão gramatical), mapeados pelas edições
export const setClaudeDiags = StateEffect.define();
// pede uma nova verificação (dicionário carregado, palavra adicionada, preferências)
const refreshLint = StateEffect.define();
export function relint(view) { view.dispatch({ effects: refreshLint.of(null) }); }
const claudeDiagsField = StateField.define({
  create: () => [],
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setClaudeDiags)) return e.value;
    if (!tr.docChanged || !v.length) return v;
    const out = [];
    for (const d of v) {
      let touched = false;
      tr.changes.iterChangedRanges((fA, tA) => { if (fA < d.to && tA > d.from) touched = true; });
      if (touched) continue;
      out.push({ ...d, from: tr.changes.mapPos(d.from), to: tr.changes.mapPos(d.to) });
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// Ortografia, formatação e gramática (lint)

const SKIP_TYPES = new Set(['title', 'scene', 'character', 'transition', 'section', 'note', 'boneyard', 'pagebreak', 'empty']);
const spellCache = new Map();
const suggestCache = new Map();

function isCorrect(word) {
  const sp = editorConfig.speller;
  if (!sp) return true;
  if (editorConfig.userWords.has(word) || editorConfig.ignored.has(word) || editorConfig.userWords.has(word.toLowerCase())) return true;
  let r = spellCache.get(word);
  if (r === undefined) { r = sp.correct(word); spellCache.set(word, r); }
  return r;
}

export function clearSpellCache() { spellCache.clear(); suggestCache.clear(); }

function replaceAction(name, from, to, insert) {
  return { name, apply: (view) => view.dispatch({ changes: { from, to, insert }, userEvent: 'input.fix' }) };
}

async function lintSource(view) {
  const { state } = view;
  const doc = state.doc;
  const types = state.field(typesField);
  const diags = [];
  const cursorLine = doc.lineAt(state.selection.main.head).number;
  const names = new Set(characterNames(doc.toString()).map((n) => n.toLowerCase()));
  let budget = performance.now() + 120; // tempo máximo para calcular sugestões

  if (editorConfig.settings.spellcheck && editorConfig.speller) {
    for (let i = 1; i <= doc.lines; i++) {
      if (SKIP_TYPES.has(types[i - 1])) continue;
      const line = doc.line(i);
      const text = line.text.replace(/\[\[.*?\]\]/g, (m) => ' '.repeat(m.length)).replace(/\b(?:https?:\/\/|www\.)\S+|\S+@\S+/g, (m) => ' '.repeat(m.length));
      for (const { word, index } of splitWords(text)) {
        if (word.length < 2) continue;
        if (word === word.toUpperCase() && word.length > 1) continue; // siglas e nomes em maiúsculas
        if (names.has(word.toLowerCase())) continue;
        if (isCorrect(word)) continue;
        const from = line.from + index, to = from + word.length;
        if (i === cursorLine && state.selection.main.head === to) continue; // ainda digitando
        let sugg = suggestCache.get(word);
        if (!sugg && performance.now() < budget) { sugg = editorConfig.speller.suggest(word, 4); suggestCache.set(word, sugg); }
        diags.push({
          from, to, severity: 'error', source: 'ortografia', markClass: 'cm-spell',
          message: `Ortografia: "${word}"${sugg && !sugg.length ? ' (sem sugestões)' : ''}`,
          actions: [
            ...(sugg || []).slice(0, 4).map((s) => replaceAction(s, from, to, s)),
            { name: 'Adicionar ao dicionário', apply: (v) => { editorConfig.userWords.add(word); editorConfig.onAddWord?.(word); relint(v); } },
            { name: 'Ignorar', apply: (v) => { editorConfig.ignored.add(word); relint(v); } },
          ],
        });
      }
    }
  }

  // avisos de formatação (exceto na linha em edição)
  for (const w of editorConfig.mode === 'plain' ? [] : formatWarnings(doc.toString())) {
    const ln = w.line + 1;
    if (ln === cursorLine || ln > doc.lines) continue;
    const line = doc.line(ln);
    const lead = line.text.length - line.text.trimStart().length;
    diags.push({
      from: line.from + lead, to: line.to, severity: 'info', source: 'formatação', markClass: 'cm-format',
      message: w.message,
      actions: w.fix != null ? [replaceAction(w.fix.startsWith('\n') ? 'Inserir linha em branco e corrigir' : `Corrigir: ${w.fix.trim().slice(0, 40)}`, line.from + lead, line.to, w.fix)] : [],
    });
  }

  // LanguageTool (opcional)
  if (editorConfig.languagetool) {
    try {
      const matches = await editorConfig.languagetool(state);
      if (view.state.doc !== doc) return [];
      for (const m of matches) {
        const from = m.from, to = m.to;
        if (from < 0 || to > doc.length || from >= to) continue;
        diags.push({
          from, to, severity: 'warning', source: 'gramática', markClass: 'cm-grammar', message: m.message,
          actions: m.replacements.map((r) => replaceAction(r, from, to, r)),
        });
      }
    } catch { /* LanguageTool indisponível */ }
  }

  for (const d of view.state.field(claudeDiagsField)) {
    diags.push({
      from: d.from, to: d.to, severity: 'warning', source: 'Claude', markClass: 'cm-grammar',
      message: `${d.explanation}`,
      actions: [replaceAction(`→ ${d.replacement.slice(0, 50)}`, d.from, d.to, d.replacement), { name: 'Ignorar', apply: (v) => v.dispatch({ effects: setClaudeDiags.of(v.state.field(claudeDiagsField).filter((x) => x !== d)) }) }],
    });
  }
  return diags;
}

// ---------------------------------------------------------------------------
// Autocorreção ao digitar

function autocorrectInput(view, from, to, text) {
  if (view.composing || from !== to) return false;
  const { state } = view;
  const line = state.doc.lineAt(from);
  const t = lineType(state, line.number);
  const cfg = editorConfig.settings.autocorrect || {};
  // linhas de personagem, cena e transição são sempre em maiúsculas
  const pend = state.field(pendingField);
  const explicit = pend && pend.pos === line.from && ['character', 'scene', 'transition'].includes(pend.type) && t === pend.type;
  if (cfg.elements !== false && (explicit || t === 'scene') && text !== text.toLocaleUpperCase('pt-BR')) {
    const inNote = /\[\[[^\]]*$/.test(line.text.slice(0, from - line.from));
    if (!inNote) {
      const up = text.toLocaleUpperCase('pt-BR');
      view.dispatch({ changes: { from, to, insert: up }, selection: { anchor: from + up.length }, userEvent: 'input.type' });
      return true;
    }
  }
  if (!['action', 'dialogue', 'parenthetical', 'plain'].includes(t)) return false;
  if (!/^[\s,.;:!?)"”…]$/.test(text)) return false;
  const before = line.text.slice(0, from - line.from);
  const m = before.match(/([\p{L}\p{M}]+)$/u);
  if (!m) return false;
  const word = m[1];
  const wFrom = from - word.length;
  let repl = word;
  if (cfg.accents !== false && editorConfig.speller && word.length > 1 && !editorConfig.userWords.has(word)) {
    const fix = editorConfig.speller.autocorrect(word);
    if (fix) repl = fix;
  }
  // maiúscula no início da frase (ação e fala)
  if (cfg.capitalize !== false && t !== 'parenthetical') {
    const pre = before.slice(0, before.length - word.length);
    const startOfSentence = /^\s*[—–-]?\s*["“]?$/.test(pre) && (line.number === 1 || !continuesSentence(state, line.number, t))
      || /[.!?…]["”]?\s+["“]?$/.test(pre);
    if (startOfSentence && repl === repl.toLocaleLowerCase('pt-BR') && !/^\d/.test(repl)) repl = repl[0].toLocaleUpperCase('pt-BR') + repl.slice(1);
  }
  if (repl === word) return false;
  view.dispatch({ changes: { from: wFrom, to: from, insert: repl + text }, selection: { anchor: wFrom + repl.length + text.length }, userEvent: 'input.autocorrect' });
  return true;
}

function continuesSentence(state, lineNo, t) {
  const prev = state.doc.line(lineNo - 1).text.trim();
  if (!prev) return false;
  const pt = lineType(state, lineNo - 1);
  if ((t === 'dialogue' && (pt === 'character' || pt === 'parenthetical'))) return false;
  return !/[.!?…:]["”]?$/.test(prev);
}

// ---------------------------------------------------------------------------
// Teclas: Enter e Tab no fluxo de roteiro

function insertAndPend(view, insert, pendType, extraChanges = []) {
  const head = view.state.selection.main.head;
  const changes = [...extraChanges, { from: head, insert }];
  const tr = view.state.update({ changes, userEvent: 'input' });
  const newHead = tr.changes.mapPos(head, 1);
  view.dispatch({
    changes, selection: { anchor: newHead }, scrollIntoView: true, userEvent: 'input',
    effects: setPending.of(pendType ? { pos: tr.state.doc.lineAt(newHead).from, type: pendType } : null),
  });
  return true;
}

function fixLineChange(state, line, fixed) {
  const lead = line.text.length - line.text.trimStart().length;
  const cur = line.text.slice(lead);
  if (!fixed || fixed === cur) return [];
  return [{ from: line.from + lead, to: line.to, insert: fixed }];
}

function screenplayEnter(view) {
  if (completionStatus(view.state) === 'active') return acceptCompletion(view);
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  if (sel.head !== line.to) return false; // no meio da linha: quebra normal
  const t = lineType(state, line.number);
  const text = line.text.trim();
  const auto = editorConfig.settings.autocorrect?.elements !== false;
  if (!text) {
    if (t === 'dialogue' || t === 'parenthetical') return insertAndPend(view, '\n', 'action');
    return false;
  }
  switch (t) {
    case 'character':
      return insertAndPend(view, '\n', 'dialogue', auto ? fixLineChange(state, line, fixCharacter(text)) : []);
    case 'parenthetical':
      return insertAndPend(view, '\n', 'dialogue');
    case 'dialogue':
      return insertAndPend(view, '\n\n', 'action');
    case 'scene':
    {
      let fixed = auto ? fixSceneHeading(text) : text;
      if (!SCENE_RE.test(fixed) && !fixed.startsWith('.')) fixed = `.${fixed}`; // cabeçalho forçado
      return insertAndPend(view, '\n\n', 'action', fixLineChange(state, line, fixed));
    }
    case 'transition':
      return insertAndPend(view, '\n\n', 'scene');
    case 'action': case 'centered': case 'lyrics':
      return insertAndPend(view, '\n\n', 'action');
    default:
      return false;
  }
}

const CYCLE = ['action', 'character', 'scene', 'transition'];

function screenplayTab(view, dir = 1) {
  if (editorConfig.mode === 'plain') { if (dir > 0) view.dispatch(view.state.replaceSelection('  ')); return true; }
  if (completionStatus(view.state) === 'active') return acceptCompletion(view);
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const t = lineType(state, line.number);
  const text = line.text;
  if (!text.trim()) {
    // linha vazia logo abaixo do personagem/fala: abre um parentético
    if (t === 'dialogue' || (t === 'empty' && line.number > 1 && ['character', 'dialogue'].includes(lineType(state, line.number - 1)) && state.doc.line(line.number - 1).text.trim())) {
      view.dispatch({ changes: { from: line.from, to: line.to, insert: '()' }, selection: { anchor: line.from + 1 }, effects: setPending.of(null) });
      return true;
    }
    const cur = CYCLE.includes(t) ? t : 'action';
    const next = CYCLE[(CYCLE.indexOf(cur) + dir + CYCLE.length) % CYCLE.length];
    const changes = [];
    // personagem e cena precisam de linha em branco antes
    if (next !== 'action' && line.number > 1 && state.doc.line(line.number - 1).text.trim()) changes.push({ from: line.from, insert: '\n' });
    const tr = state.update({ changes });
    const pos = tr.changes.mapPos(line.from, 1);
    view.dispatch({ changes, selection: { anchor: pos }, effects: setPending.of({ pos, type: next }) });
    if (next === 'scene' || next === 'transition' || next === 'character') startCompletion(view);
    return true;
  }
  // linha com texto: converte o elemento
  const cur = CYCLE.includes(t) ? t : 'action';
  const next = CYCLE[(CYCLE.indexOf(cur) + dir + CYCLE.length) % CYCLE.length];
  let body = text.trim().replace(/^[!@.>~]\s*/, '');
  let out;
  if (next === 'character') out = body.toLocaleUpperCase('pt-BR').replace(/[.:]$/, '');
  else if (next === 'scene') { const up = body.toLocaleUpperCase('pt-BR'); out = SCENE_RE.test(up) ? up : `.${up}`; }
  else if (next === 'transition') { const up = body.toLocaleUpperCase('pt-BR'); out = /(TO|PARA):$/.test(up) ? up : `> ${up}`; }
  else out = isUpperLine(body) || SCENE_RE.test(body) ? `!${body}` : body;
  const changes = [{ from: line.from, to: line.to, insert: out }];
  if (next !== 'action' && line.number > 1 && state.doc.line(line.number - 1).text.trim()) changes.unshift({ from: line.from, insert: '\n' });
  const tr = state.update({ changes });
  const anchor = tr.changes.mapPos(line.to, 1);
  view.dispatch({ changes, selection: { anchor }, userEvent: 'input', effects: setPending.of({ pos: tr.state.doc.lineAt(anchor).from, type: next }) });
  return true;
}

// ---------------------------------------------------------------------------
// Autocompletar: personagens, locações, períodos e transições

function completions(ctx) {
  if (editorConfig.mode === 'plain') return null;
  const { state, pos } = ctx;
  const line = state.doc.lineAt(pos);
  const t = lineType(state, line.number);
  const before = line.text.slice(0, pos - line.from);
  const doc = state.doc.toString();
  const en = editorConfig.settings.lang === 'en-US';
  const prevBlank = line.number === 1 || !state.doc.line(line.number - 1).text.trim();

  if (t === 'character' || (prevBlank && /^\p{Lu}[\p{Lu}\s.'-]*$/u.test(before) && before.length >= 2 && t !== 'scene')) {
    const extM = before.match(/^(.*\S)\s+\(([\p{L}.']*)$/u);
    if (extM) {
      const exts = en ? ['(V.O.)', '(O.S.)', "(CONT'D)"] : ['(V.O.)', '(O.S.)', '(CONT.)', '(OFF)'];
      const start = pos - extM[2].length - 1;
      return { from: start, options: exts.map((e) => ({ label: e, type: 'keyword' })), validFor: /^\([\p{L}.']*\)?$/u };
    }
    // nomes do resto do documento (sem a linha em edição)
    const others = state.doc.sliceString(0, line.from) + state.doc.sliceString(line.to);
    const current = before.trim();
    const names = characterNames(others).filter((n) => n !== current);
    if (!names.length) return null;
    return { from: line.from + (line.text.length - line.text.trimStart().length), options: names.map((n) => ({ label: n, type: 'variable', apply: n })), validFor: /^[\p{Lu}\s.'-]*$/u };
  }
  if (t === 'scene' || (prevBlank && /^(\.|I|IN|INT|E|EX|EXT)$/i.test(before))) {
    const pm = before.match(/^(\.?(?:INT\.?\/EXT\.?|EXT\.?\/INT\.?|INT\.?|EXT\.?|EST\.?|I\/E\.?))\s+/i);
    if (!pm) {
      return { from: line.from, options: ['INT. ', 'EXT. ', 'INT./EXT. '].map((l) => ({ label: l.trim(), apply: l, type: 'keyword' })), validFor: /^[\w./]*$/ };
    }
    const dash = before.match(/^(.*?\s[-–—]\s)(.*)$/);
    if (dash) {
      const times = en ? TIMES_EN : TIMES_PT;
      return { from: line.from + dash[1].length, options: times.map((x) => ({ label: x, type: 'constant' })), validFor: /^[\p{L} ]*$/u };
    }
    const locs = locations(doc).filter((l) => l !== parseScene(before).location.toUpperCase());
    if (!locs.length) return null;
    return { from: line.from + pm[0].length, options: locs.map((l) => ({ label: l, apply: `${l} - `, type: 'text' })), validFor: /^[\p{L}\d\s'.]*$/u };
  }
  if (t === 'transition') {
    return { from: line.from, options: TRANSITIONS.map((x) => ({ label: x, type: 'keyword' })), validFor: /^[\p{L}\s:.]*$/u };
  }
  return null;
}

// ---------------------------------------------------------------------------

const theme = EditorView.theme({
  '&': { height: '100%', background: 'transparent' },
  '.cm-scroller': { fontFamily: 'var(--script-font)', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '&.cm-focused': { outline: 'none' },
});

// ---------------------------------------------------------------------------
// Alterações propostas pelo Claude, mostradas no texto para revisão
// (removido riscado, novo em destaque, ✓ aceita, ✗ rejeita)

const setSuggestions = StateEffect.define();
let suggestionSeq = 0;

class SuggestionWidget extends WidgetType {
  constructor(s) { super(); this.s = s; }
  eq(o) { return o.s.id === this.s.id; }
  toDOM(view) {
    const wrap = document.createElement('span');
    wrap.className = 'sug';
    wrap.title = this.s.reason || '';
    if (this.s.replacement) {
      const ins = document.createElement('span');
      ins.className = 'sug-ins';
      ins.textContent = this.s.replacement;
      wrap.append(ins);
    }
    const mk = (label, cls, title, fn) => {
      const b = document.createElement('button');
      b.className = cls; b.textContent = label; b.title = title;
      b.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); fn(); };
      return b;
    };
    wrap.append(
      mk('✓', 'sug-ok', `Aceitar${this.s.reason ? ': ' + this.s.reason : ''}`, () => acceptSuggestion(view, this.s.id)),
      mk('✗', 'sug-no', 'Rejeitar', () => rejectSuggestion(view, this.s.id)),
    );
    return wrap;
  }
  ignoreEvent() { return true; }
}

const suggestionsField = StateField.define({
  create: () => [],
  update(v, tr) {
    let next = v;
    for (const e of tr.effects) if (e.is(setSuggestions)) next = e.value;
    if (!tr.docChanged || !next.length) return next;
    const out = [];
    for (const s of next) {
      let touched = false;
      tr.changes.iterChangedRanges((fA, tA) => { if (fA < s.to && tA > s.from) touched = true; if (s.from === s.to && fA === s.from) touched = true; });
      if (touched) continue; // o autor editou o trecho: a sugestão perde o sentido
      out.push({ ...s, from: tr.changes.mapPos(s.from, 1), to: tr.changes.mapPos(s.to, -1) });
    }
    return out;
  },
  provide: (f) => EditorView.decorations.from(f, (list) => Decoration.set(list.flatMap((s) => [
    ...(s.to > s.from ? [Decoration.mark({ class: 'sug-del', attributes: { title: s.reason || '' } }).range(s.from, s.to)] : []),
    Decoration.widget({ widget: new SuggestionWidget(s), side: 1 }).range(s.to),
  ]), true)),
});

export function getSuggestions(state) { return state.field(suggestionsField); }

export function acceptSuggestion(view, id) {
  const list = view.state.field(suggestionsField);
  const s = list.find((x) => x.id === id);
  if (!s) return;
  view.dispatch({ changes: { from: s.from, to: s.to, insert: s.replacement }, effects: setSuggestions.of(list.filter((x) => x !== s)), userEvent: 'input.claude' });
}
export function rejectSuggestion(view, id) {
  view.dispatch({ effects: setSuggestions.of(view.state.field(suggestionsField).filter((x) => x.id !== id)) });
}
export function acceptAll(view) {
  const list = view.state.field(suggestionsField);
  if (!list.length) return 0;
  view.dispatch({ changes: list.map((s) => ({ from: s.from, to: s.to, insert: s.replacement })), effects: setSuggestions.of([]), userEvent: 'input.claude' });
  return list.length;
}
export function rejectAll(view) { view.dispatch({ effects: setSuggestions.of([]) }); }
export function nextSuggestion(view) {
  const list = view.state.field(suggestionsField);
  if (!list.length) return;
  const head = view.state.selection.main.head;
  const s = list.find((x) => x.from > head) || list[0];
  goTo(view, s.from);
}

/**
 * Localiza as substituições do Claude no texto (dentro de [rangeFrom, rangeTo]) e
 * as mostra para revisão, ou aplica direto. Retorna { found, missing }.
 */
export function proposeEdits(view, edits, rangeFrom, rangeTo, { direct = false } = {}) {
  const text = view.state.doc.sliceString(rangeFrom, rangeTo);
  const found = [];
  let missing = 0;
  let cursor = 0;
  for (const e of edits) {
    if (!e.original || e.original === e.replacement) { if (!e.original && e.replacement) missing++; continue; }
    // procura a partir da última posição (as edições vêm em ordem); se não achar, do início
    let idx = text.indexOf(e.original, cursor);
    if (idx === -1) idx = text.indexOf(e.original);
    if (idx === -1) { missing++; continue; }
    const from = rangeFrom + idx, to = from + e.original.length;
    if (found.some((f) => from < f.to && to > f.from)) { missing++; continue; }
    // mostra só a parte que muda (prefixo e sufixo iguais ficam de fora)
    let a = 0;
    while (a < e.original.length && a < e.replacement.length && e.original[a] === e.replacement[a]) a++;
    let z = 0;
    while (z < e.original.length - a && z < e.replacement.length - a && e.original[e.original.length - 1 - z] === e.replacement[e.replacement.length - 1 - z]) z++;
    // recorta em palavras inteiras, para nunca riscar meia palavra
    while (a > 0 && /\S/.test(e.original[a - 1])) a--;
    while (z > 0 && /\S/.test(e.original[e.original.length - z])) z--;
    found.push({ id: ++suggestionSeq, from: from + a, to: to - z, replacement: e.replacement.slice(a, e.replacement.length - z), reason: e.reason || '' });
    cursor = idx + e.original.length;
  }
  found.sort((x, y) => x.from - y.from);
  if (direct) {
    if (found.length) view.dispatch({ changes: found.map((s) => ({ from: s.from, to: s.to, insert: s.replacement })), userEvent: 'input.claude' });
  } else {
    const keep = view.state.field(suggestionsField).filter((s) => !found.some((f) => s.from < f.to && s.to > f.from));
    view.dispatch({ effects: setSuggestions.of([...keep, ...found].sort((x, y) => x.from - y.from)) });
    if (found.length) goTo(view, found[0].from);
  }
  return { found: found.length, missing };
}

export function createEditor(parent, { doc = '', onChange, onSelection, onUpdate } = {}) {
  const state = EditorState.create({
    doc,
    extensions: [
      typesField, pendingField, claudeDiagsField, sceneNumField, pagesField, suggestionsField,
      lineDecorations,
      history(),
      drawSelection(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      EditorView.lineWrapping,
      EditorState.allowMultipleSelections.of(false),
      EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off', 'aria-label': 'Roteiro' }),
      placeholder('Comece a escrever.  Tab alterna o elemento (personagem, cena, transição).  Ctrl+K abre os comandos.'),
      autocompletion({ override: [completions], icons: false, activateOnTyping: true, closeOnBlur: true }),
      linter(lintSource, {
        delay: 700,
        needsRefresh: (u) => u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshLint) || e.is(setClaudeDiags))),
      }),
      Prec.high(EditorView.inputHandler.of(autocorrectInput)),
      Prec.high(keymap.of([
        { key: 'Enter', run: screenplayEnter },
        { key: 'Shift-Enter', run: (v) => { v.dispatch(v.state.replaceSelection('\n'), { scrollIntoView: true }); return true; } },
        { key: 'Tab', run: (v) => screenplayTab(v, 1), shift: (v) => screenplayTab(v, -1) },
        { key: 'Mod-b', run: toggleWrap('**') },
        { key: 'Mod-i', run: toggleWrap('*') },
        { key: 'Mod-u', run: toggleWrap('_') },
      ])),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      theme,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChange?.(u);
        if (u.selectionSet || u.docChanged) onSelection?.(u);
        onUpdate?.(u);
      }),
    ],
  });
  return new EditorView({ state, parent });
}

export function setDoc(view, text) {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 }, effects: [setPending.of(null), setClaudeDiags.of([])] });
}

/** Cena (índice, número, intervalo) em que está o cursor. */
export function currentScene(view) {
  const { state } = view;
  const types = state.field(typesField);
  const head = state.doc.lineAt(state.selection.main.head).number;
  let start = null, count = 0, startLine = 1;
  for (let i = 1; i <= state.doc.lines; i++) {
    if (types[i - 1] === 'scene') { count++; if (i <= head) { start = count; startLine = i; } else if (start !== null) return finish(i - 1); }
  }
  return finish(state.doc.lines);
  function finish(endLine) {
    const from = state.doc.line(startLine).from, to = state.doc.line(endLine).to;
    return { index: start ? start - 1 : -1, from, to, text: state.doc.sliceString(from, to), total: count };
  }
}

export function sceneRanges(view) {
  const { state } = view;
  const types = state.field(typesField);
  const out = [];
  for (let i = 1; i <= state.doc.lines; i++) if (types[i - 1] === 'scene') out.push({ line: i, from: state.doc.line(i).from, text: state.doc.line(i).text.trim() });
  return out;
}

export function goTo(view, pos, { select = 0 } = {}) {
  view.dispatch({ selection: EditorSelection.single(pos, pos + select), effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
  view.focus();
}

/** Converte correções do Claude (trecho original → substituição) em diagnósticos no texto. */
export function applyClaudeCorrections(view, corrections, rangeFrom = 0, rangeTo = view.state.doc.length) {
  const text = view.state.doc.sliceString(rangeFrom, rangeTo);
  const used = new Set();
  const diags = [];
  for (const c of corrections) {
    if (!c.original || c.original === c.replacement) continue;
    let idx = text.indexOf(c.original);
    while (idx !== -1 && used.has(idx)) idx = text.indexOf(c.original, idx + 1);
    if (idx === -1) continue;
    used.add(idx);
    diags.push({ from: rangeFrom + idx, to: rangeFrom + idx + c.original.length, replacement: c.replacement, explanation: `${c.kind}: ${c.explanation}` });
  }
  const prev = view.state.field(claudeDiagsField).filter((d) => d.to <= rangeFrom || d.from >= rangeTo);
  view.dispatch({ effects: setClaudeDiags.of([...prev, ...diags]) });
  return diags.length;
}

export { typesField, claudeDiagsField };
