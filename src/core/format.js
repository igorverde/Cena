// Correção automática de formatação do roteiro (Fountain).
// fixFormatting() devolve o texto corrigido e a lista de mudanças.
import { classifyLines, SCENE_RE, parseCharacter, isUpperLine } from './fountain.js';

const EXT_MAP = {
  'VO': 'V.O.', 'V.O': 'V.O.', 'V.O.': 'V.O.', 'OFF': 'O.S.', 'OS': 'O.S.', 'O.S': 'O.S.', 'O.S.': 'O.S.', 'OC': 'O.C.',
  "CONT'D": "CONT'D", 'CONTD': "CONT'D", 'CONT': 'CONT.', 'CONT.': 'CONT.', 'CONTINUANDO': 'CONT.',
};

/** Ajustes de pontuação e espaçamento em texto corrido (ação e diálogo). */
export function fixProse(s, { capitalize = true } = {}) {
  let t = s;
  t = t.replace(/[ \t]{2,}/g, ' ');
  t = t.replace(/\s+([,.;:!?])(?!\d)/g, '$1');            // espaço antes da pontuação
  t = t.replace(/([,;])(?=[\p{L}])/gu, '$1 ');             // falta espaço depois da vírgula
  t = t.replace(/([.!?])(?=\p{Lu}\p{Ll})/gu, '$1 ');       // falta espaço entre frases
  t = t.replace(/\.{4,}/g, '...');
  t = t.replace(/\b(\p{L}+) \1\b/giu, (m, w) => (w.length > 2 && !/^(né|lá|já|só|tá|vai|não|sim|ha|he|hi|ho|bla)$/i.test(w) ? w : m)); // palavra repetida
  if (capitalize) {
    t = t.replace(/^(\s*[¿¡"“'(—–-]*\s*)(\p{Ll})/u, (m, a, b) => a + b.toLocaleUpperCase('pt-BR'));
    t = t.replace(/([.!?]\s+["“]?)(\p{Ll})/gu, (m, a, b) => a + b.toLocaleUpperCase('pt-BR'));
  }
  t = t.replace(/\b(\p{Lu})(\p{Lu})(\p{Ll}{2,})/gu, (m, a, b, c) => a + b.toLocaleLowerCase('pt-BR') + c); // "COm" -> "Com"
  return t.replace(/\s+$/, '');
}

export function fixSceneHeading(line) {
  let s = line.trim();
  const forced = /^\.[^.]/.test(s);
  if (forced) s = s.slice(1).trim();
  const num = s.match(/\s*#[\w.-]+#\s*$/);
  const numStr = num ? ' ' + num[0].trim() : '';
  if (num) s = s.slice(0, num.index);
  s = s.replace(/^(INT|EXT|EST)\s*\/\s*(INT|EXT)\.?\s*/i, (m, a, b) => `${a.toUpperCase()}./${b.toUpperCase()}. `);
  s = s.replace(/^(INT|EXT|EST|I\/E)(?![./])\.?\s*/i, (m, a) => `${a.toUpperCase()}. `);
  s = s.replace(/\s*[-–—]+\s*(?=\S+$|\S.*$)/, (m) => ' - ');
  s = s.replace(/\s*[-–—]\s*/g, ' - ').replace(/\s{2,}/g, ' ');
  s = s.toLocaleUpperCase('pt-BR').trim();
  return (forced && !SCENE_RE.test(s) ? '.' : '') + s + numStr;
}

export function fixCharacter(line) {
  const { name, ext, dual } = parseCharacter(line);
  const forced = line.trim().startsWith('@') && !isUpperLine(name);
  let exts = ext ? ext.match(/\(([^)]*)\)/g).map((x) => {
    const inner = x.slice(1, -1).trim().toLocaleUpperCase('pt-BR');
    return `(${EXT_MAP[inner] || inner})`;
  }).join(' ') : '';
  const n = forced ? '@' + name : name.toLocaleUpperCase('pt-BR');
  return n + (exts ? ' ' + exts : '') + (dual ? ' ^' : '');
}

export function fixParenthetical(line) {
  let s = line.trim().replace(/^\(\s*/, '(').replace(/\s*\)$/, ')');
  if (!s.startsWith('(')) s = '(' + s;
  if (!s.endsWith(')')) s += ')';
  // convenção: parentético em minúsculas, sem ponto final
  s = s.replace(/^\((\p{Lu})(\p{Ll})/u, (m, a, b) => '(' + a.toLocaleLowerCase('pt-BR') + b).replace(/\.\)$/, ')');
  return s;
}

/**
 * Corrige o documento inteiro.
 * @returns {{ text: string, changes: Array<{line:number, before:string, after:string, reason:string}> }}
 */
export function fixFormatting(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const types = classifyLines(lines.join('\n'));
  const changes = [];
  const out = [];
  const set = (i, after, reason) => {
    if (after !== lines[i]) changes.push({ line: i, before: lines[i], after, reason });
    return after;
  };
  for (let i = 0; i < lines.length; i++) {
    const t = types[i];
    let l = lines[i];
    // linha que parece cabeçalho de cena mas está colada à ação anterior
    if (t === 'action' && SCENE_RE.test(l.trim()) && /\s[-–—]\s*\S/.test(l) && i > 0 && lines[i - 1].trim() !== '') {
      out.push('');
      changes.push({ line: i, before: l, after: '\n' + fixSceneHeading(l), reason: 'linha em branco antes do cabeçalho de cena' });
      out.push(fixSceneHeading(l));
      continue;
    }
    switch (t) {
      case 'scene': l = set(i, fixSceneHeading(l), 'cabeçalho de cena padronizado'); break;
      case 'character': l = set(i, fixCharacter(l), 'nome de personagem padronizado'); break;
      case 'parenthetical': l = set(i, fixParenthetical(l), 'parentético padronizado'); break;
      case 'dialogue': l = set(i, fixProse(l, { capitalize: types[i - 1] !== 'dialogue' || /[.!?]["”]?$/.test(lines[i - 1].trim()) }), 'pontuação/espaçamento'); break;
      case 'action': if (l.trim() && !l.startsWith(' ') && !l.startsWith('!')) l = set(i, fixProse(l, { capitalize: types[i - 1] !== 'action' || lines[i - 1].trim() === '' || /[.!?]["”]?$/.test(lines[i - 1].trim()) }), 'pontuação/espaçamento'); break;
      case 'transition': if (!l.trim().startsWith('>')) l = set(i, l.trim().toLocaleUpperCase('pt-BR'), 'transição em maiúsculas'); break;
      default: if (t !== 'title' && t !== 'boneyard' && t !== 'note') l = set(i, l.replace(/[ \t]+$/, ''), 'espaços no fim da linha');
    }
    out.push(l);
  }
  // no máximo duas linhas em branco seguidas
  let res = out.join('\n').replace(/\n{4,}/g, '\n\n\n');
  if (!res.endsWith('\n')) res += '\n';
  return { text: res, changes };
}

/** Lista de avisos de formatação (sem alterar o texto), para o editor. */
export function formatWarnings(text) {
  const lines = text.split('\n');
  const types = classifyLines(text);
  const warns = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const t = types[i];
    if (t === 'scene') {
      const fixed = fixSceneHeading(l);
      if (fixed !== l.trim()) warns.push({ line: i, message: 'Cabeçalho de cena fora do padrão', fix: fixed });
      else if (!/\s-\s\S/.test(l) && !/^\./.test(l.trim())) warns.push({ line: i, message: 'Cabeçalho sem período do dia (ex.: " - DIA")', fix: null });
    } else if (t === 'character') {
      const fixed = fixCharacter(l);
      if (fixed !== l.trim()) warns.push({ line: i, message: 'Nome de personagem fora do padrão', fix: fixed });
      if (types[i + 1] !== 'dialogue' && types[i + 1] !== 'parenthetical' && i + 1 < lines.length) warns.push({ line: i, message: 'Personagem sem fala', fix: null });
    } else if (t === 'parenthetical') {
      const fixed = fixParenthetical(l);
      if (fixed !== l.trim()) warns.push({ line: i, message: 'Parentético fora do padrão', fix: fixed });
    } else if (t === 'action' && SCENE_RE.test(l.trim()) && /\s[-–—]\s*\S/.test(l) && i > 0 && lines[i - 1].trim() !== '') {
      warns.push({ line: i, message: 'Cabeçalho de cena precisa de uma linha em branco antes', fix: '\n' + fixSceneHeading(l) });
    } else if (t === 'dialogue' || (t === 'action' && l.trim() && !l.startsWith('!'))) {
      const fixed = fixProse(l, { capitalize: false });
      if (fixed !== l.replace(/\s+$/, '')) warns.push({ line: i, message: 'Espaçamento ou pontuação', fix: fixed });
    }
  }
  return warns;
}
