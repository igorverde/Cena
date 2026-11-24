// Parser Fountain (https://fountain.io) com extensões para roteiros em português.
// classifyLines() é usado pelo editor (um tipo por linha);
// parse() produz a lista de elementos usada na exportação e nas estatísticas.

export const SCENE_RE = /^(?:INT\.?\/EXT|EXT\.?\/INT|INT|EXT|EST|I\/E|E\/I)(?:\.|\s)/i;
const TRANSITION_WORDS = [
  'FADE IN:', 'FADE OUT.', 'FADE OUT:', 'FADE TO BLACK.', 'CUT TO BLACK.', 'CORTA PARA:', 'CORTE PARA:',
  'CORTE SECO:', 'FUSÃO:', 'FUSÃO PARA:', 'ABRE EM:', 'FECHA EM:', 'ESCURECE.', 'FIM.', 'THE END', 'FIM',
];
const TITLE_KEY_RE = /^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ \t]*?):\s*(.*)$/;

export const TIMES_PT = ['DIA', 'NOITE', 'TARDE', 'MANHÃ', 'AMANHECER', 'ENTARDECER', 'ANOITECER', 'MADRUGADA', 'CONTÍNUO', 'MAIS TARDE', 'MOMENTOS DEPOIS', 'MESMO MOMENTO'];
export const TIMES_EN = ['DAY', 'NIGHT', 'MORNING', 'AFTERNOON', 'EVENING', 'DAWN', 'DUSK', 'CONTINUOUS', 'LATER', 'MOMENTS LATER'];
export const TRANSITIONS = ['CORTA PARA:', 'FUSÃO PARA:', 'CORTE SECO PARA:', 'FADE IN:', 'FADE OUT.', 'ESCURECE.', 'CUT TO:', 'DISSOLVE TO:', 'SMASH CUT TO:', 'MATCH CUT TO:'];

export function isUpperLine(s) {
  const letters = s.replace(/\(.*?\)/g, '').replace(/[^\p{L}]/gu, '');
  return letters.length > 0 && letters === letters.toLocaleUpperCase('pt-BR') && /\p{Lu}/u.test(letters);
}

function isTransition(t) {
  const s = t.trim();
  if (!isUpperLine(s)) return false;
  if (TRANSITION_WORDS.includes(s)) return true;
  return /(?:\sTO|\sPARA):$/.test(s);
}

// Comprimento do bloco de página de título, em linhas (0 se não houver).
export function titlePageLength(lines) {
  if (!lines.length || !TITLE_KEY_RE.test(lines[0]) || SCENE_RE.test(lines[0])) return 0;
  let i = 0;
  while (i < lines.length && lines[i].trim() !== '') i++;
  return i;
}

/**
 * Classifica cada linha do texto. Tipos:
 * title, scene, action, character, parenthetical, dialogue, lyrics, transition,
 * centered, pagebreak, section, synopsis, note, boneyard, empty
 */
export function classifyLines(text) {
  const lines = text.split('\n');
  const types = new Array(lines.length).fill('action');
  const tp = titlePageLength(lines);
  for (let i = 0; i < tp; i++) types[i] = 'title';
  let inBone = false;
  let inNote = false;
  let block = null; // 'dialogue' enquanto estiver num bloco de fala
  for (let i = tp; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    // boneyard /* ... */ e notas [[ ... ]] de várias linhas
    if (inBone) { types[i] = 'boneyard'; if (raw.includes('*/')) inBone = false; continue; }
    if (line.startsWith('/*')) { types[i] = 'boneyard'; inBone = !raw.includes('*/', raw.indexOf('/*') + 2); block = null; continue; }
    if (inNote) { types[i] = 'note'; if (raw.includes(']]')) inNote = false; continue; }
    if (line.startsWith('[[') && !line.includes(']]')) { types[i] = 'note'; inNote = true; continue; }
    if (line.startsWith('[[') && line.endsWith(']]') && line.indexOf('[[', 2) === -1) { types[i] = 'note'; continue; }

    if (line === '' && raw.length < 2) { types[i] = 'empty'; block = null; continue; }
    if (block === 'dialogue') {
      types[i] = /^\(.*\)$/.test(line) ? 'parenthetical' : 'dialogue';
      continue;
    }
    const prevBlank = i === tp || lines[i - 1].trim() === '' || types[i - 1] === 'title';
    const next = lines[i + 1];
    const nextBlank = next === undefined || next.trim() === '';

    if (/^={3,}$/.test(line)) { types[i] = 'pagebreak'; continue; }
    if (line.startsWith('#')) { types[i] = 'section'; continue; }
    if (line.startsWith('=')) { types[i] = 'synopsis'; continue; }
    if (line.startsWith('!')) { types[i] = 'action'; continue; }
    if (line.startsWith('~')) { types[i] = 'lyrics'; continue; }
    if (line.startsWith('>') && line.endsWith('<')) { types[i] = 'centered'; continue; }
    if (line.startsWith('>')) { types[i] = 'transition'; continue; }
    if (line.startsWith('@')) { types[i] = 'character'; block = 'dialogue'; continue; }
    if (/^\.[^.]/.test(line) && prevBlank) { types[i] = 'scene'; continue; }
    if (prevBlank && SCENE_RE.test(line)) { types[i] = 'scene'; continue; }
    if (prevBlank && nextBlank && isTransition(line)) { types[i] = 'transition'; continue; }
    if (prevBlank && !nextBlank && isUpperLine(line) && !raw.startsWith('  ')) {
      types[i] = 'character'; block = 'dialogue'; continue;
    }
    // Linha em maiúsculas digitada agora, no fim do documento: trata como personagem
    if (prevBlank && next === undefined && isUpperLine(line) && line.replace(/[^\p{L}]/gu, '').length >= 2 && line.length < 40 && !/[.!?]$/.test(line)) {
      types[i] = 'character'; continue;
    }
    types[i] = 'action';
  }
  return types;
}

export function parseCharacter(line) {
  let s = line.trim();
  let dual = false;
  if (s.endsWith('^')) { dual = true; s = s.slice(0, -1).trim(); }
  if (s.startsWith('@')) s = s.slice(1);
  const m = s.match(/^(.*?)\s*((?:\([^)]*\)\s*)*)$/);
  const name = (m ? m[1] : s).trim();
  const ext = m && m[2] ? m[2].trim() : '';
  return { name, ext, dual };
}

export function parseScene(line) {
  let s = line.trim();
  let number = null;
  const nm = s.match(/\s*#([\w.-]+)#\s*$/);
  if (nm) { number = nm[1]; s = s.slice(0, nm.index).trim(); }
  if (/^\.[^.]/.test(s)) s = s.slice(1).trim();
  const pm = s.match(/^(INT\.?\/EXT\.?|EXT\.?\/INT\.?|INT\.?|EXT\.?|EST\.?|I\/E\.?|E\/I\.?)\s*/i);
  const prefix = pm ? pm[1].toUpperCase() : '';
  const rest = pm ? s.slice(pm[0].length) : s;
  const dash = rest.match(/^(.*?)\s+[-–—]\s+(.*)$/);
  const location = (dash ? dash[1] : rest).trim();
  const time = dash ? dash[2].trim() : '';
  let intExt = '';
  if (/^(INT\.?\/EXT|EXT\.?\/INT|I\/E|E\/I)/i.test(prefix)) intExt = 'INT/EXT';
  else if (/^INT/i.test(prefix)) intExt = 'INT';
  else if (/^(EXT|EST)/i.test(prefix)) intExt = 'EXT';
  return { text: s, number, prefix, location, time, intExt };
}

export function stripNotes(s) {
  return s.replace(/\[\[[\s\S]*?\]\]/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Converte ênfases Fountain em segmentos: [{text,bold,italic,underline}] */
export function inlineSegments(text) {
  const segs = [];
  let bold = false, italic = false, underline = false;
  let buf = '';
  const flush = () => { if (buf) segs.push({ text: buf, bold, italic, underline }); buf = ''; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) { buf += text[++i]; continue; }
    if (c === '*' && text[i + 1] === '*' && text[i + 2] === '*') {
      if ((bold && italic) || hasCloser(text, i + 3, '***')) { flush(); bold = !bold; italic = !italic; i += 2; continue; }
    }
    if (c === '*' && text[i + 1] === '*') {
      if (bold || hasCloser(text, i + 2, '**')) { flush(); bold = !bold; i += 1; continue; }
    }
    if (c === '*') {
      if (italic || hasCloser(text, i + 1, '*')) { flush(); italic = !italic; continue; }
    }
    if (c === '_') {
      if (underline || hasCloser(text, i + 1, '_')) { flush(); underline = !underline; continue; }
    }
    buf += c;
  }
  flush();
  return segs;
}
function hasCloser(text, from, token) {
  const j = text.indexOf(token, from);
  return j > from && !text.slice(from, j).includes('\n');
}
export function plain(text) { return inlineSegments(stripNotes(text)).map((s) => s.text).join(''); }

/** Analisa o texto completo em { title: {chave: valor}, elements: [...] } */
export function parse(text) {
  text = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  const lines = text.split('\n');
  const types = classifyLines(text);
  const title = {};
  const tp = titlePageLength(lines);
  let key = null;
  for (let i = 0; i < tp; i++) {
    const m = lines[i].match(TITLE_KEY_RE);
    if (m && !/^\s{2,}|\t/.test(lines[i])) {
      key = m[1].trim().toLowerCase();
      title[key] = m[2] ? [m[2].trim()] : [];
    } else if (key) title[key].push(lines[i].trim());
  }
  const elements = [];
  let sceneCount = 0;
  const push = (el) => { elements.push(el); return el; };
  for (let i = tp; i < lines.length; i++) {
    const t = types[i];
    const raw = lines[i];
    const line = raw.trim();
    const last = elements[elements.length - 1];
    switch (t) {
      case 'empty': case 'boneyard': case 'note':
        if (t === 'empty' && last && last.type === 'action' && !last.closed) last.closed = true;
        break;
      case 'scene': {
        const sc = parseScene(line);
        sceneCount++;
        push({ type: 'scene', text: sc.text.toUpperCase(), number: sc.number || String(sceneCount), info: sc, line: i });
        break;
      }
      case 'character': {
        const c = parseCharacter(line);
        push({ type: 'character', text: (c.name.toUpperCase() + (c.ext ? ' ' + c.ext.toUpperCase() : '')), name: c.name.toUpperCase(), ext: c.ext, dual: c.dual, line: i });
        if (c.dual) {
          // marca o bloco de fala anterior como primeira coluna
          for (let k = elements.length - 2; k >= 0; k--) {
            const e = elements[k];
            if (e.type === 'character') { e.dual = 'left'; break; }
            if (!['dialogue', 'parenthetical'].includes(e.type)) break;
          }
          elements[elements.length - 1].dual = 'right';
        }
        break;
      }
      case 'parenthetical': push({ type: 'parenthetical', text: line, line: i }); break;
      case 'dialogue': {
        if (last && last.type === 'dialogue') last.text += '\n' + line;
        else push({ type: 'dialogue', text: line, line: i });
        break;
      }
      case 'transition': push({ type: 'transition', text: line.replace(/^>\s*/, '').toUpperCase(), line: i }); break;
      case 'centered': push({ type: 'centered', text: line.slice(1, -1).trim(), line: i }); break;
      case 'lyrics': push({ type: 'lyrics', text: line.slice(1).trim(), line: i }); break;
      case 'pagebreak': push({ type: 'pagebreak', line: i }); break;
      case 'section': push({ type: 'section', depth: line.match(/^#+/)[0].length, text: line.replace(/^#+\s*/, ''), line: i }); break;
      case 'synopsis': push({ type: 'synopsis', text: line.replace(/^=\s*/, ''), line: i }); break;
      default: {
        const txt = raw.startsWith('!') ? raw.slice(1) : raw.replace(/^\s{0,1}(?=\S)/, '');
        if (last && last.type === 'action' && !last.closed) last.text += '\n' + txt;
        else push({ type: 'action', text: txt, line: i });
      }
    }
  }
  for (const e of elements) {
    delete e.closed;
    if (e.text !== undefined) e.text = stripNotes(e.text).replace(/[ \t]+$/gm, '');
  }
  return { title, elements: elements.filter((e) => e.type !== 'action' || e.text.trim() !== '') };
}

/** Lista de cenas com metadados, a partir dos elementos. */
export function scenes(parsed) {
  const out = [];
  let cur = null;
  for (const e of parsed.elements) {
    if (e.type === 'scene') {
      cur = { ...e.info, number: e.number, heading: e.text, line: e.line, characters: new Set(), elements: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    cur.elements.push(e);
    if (e.type === 'character') cur.characters.add(e.name);
  }
  return out.map((s) => ({ ...s, characters: [...s.characters] }));
}

export function characterNames(text) {
  const types = classifyLines(text);
  const lines = text.split('\n');
  const counts = new Map();
  types.forEach((t, i) => {
    if (t !== 'character') return;
    const { name } = parseCharacter(lines[i]);
    if (name) counts.set(name.toUpperCase(), (counts.get(name.toUpperCase()) || 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
}

export function locations(text) {
  const types = classifyLines(text);
  const lines = text.split('\n');
  const set = new Set();
  types.forEach((t, i) => { if (t === 'scene') { const l = parseScene(lines[i]).location.toUpperCase(); if (l) set.add(l); } });
  return [...set];
}
