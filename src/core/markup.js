// Localiza as marcações Fountain de uma linha para o modo WYSIWYG do editor:
// o que esconder (asteriscos, sublinhados, barras de escape, colchetes de nota)
// e o que estilizar (negrito, itálico, sublinhado, nota).

/**
 * @param {string} text  uma linha
 * @returns {{ hide: [number, number][], marks: [number, number, string][] }}
 *   posições relativas ao início da linha; classes: em-b, em-i, em-u, em-note
 */
export function inlineMarkup(text) {
  const hide = [];
  const marks = [];
  // notas [[...]] não têm ênfase: viram espaços para a varredura
  let scan = text;
  for (const m of text.matchAll(/\[\[([\s\S]*?)\]\]/g)) {
    hide.push([m.index, m.index + 2], [m.index + m[0].length - 2, m.index + m[0].length]);
    marks.push([m.index + 2, m.index + m[0].length - 2, 'em-note']);
    scan = scan.slice(0, m.index) + ' '.repeat(m[0].length) + scan.slice(m.index + m[0].length);
  }
  emphasis(scan, 0, scan.length, hide, marks);
  hide.sort((a, b) => a[0] - b[0]);
  return { hide, marks };
}

function runLength(s, i, ch) { let k = 0; while (s[i + k] === ch) k++; return k; }

function emphasis(s, from, to, hide, marks) {
  let i = from;
  while (i < to) {
    const c = s[i];
    if (c === '\\' && (s[i + 1] === '*' || s[i + 1] === '_') && i + 1 < to) { hide.push([i, i + 1]); i += 2; continue; }
    if (c !== '*' && c !== '_') { i++; continue; }
    const run = runLength(s, i, c);
    const k = c === '_' ? 1 : Math.min(run, 3);
    const open = i + k;
    if (c === '*' && run > 3) { i += run; continue; }
    if (open >= to || s[open] === ' ') { i += run; continue; }
    // procura o fechamento com o mesmo número de marcadores, colado ao texto
    let j = open;
    let close = -1;
    while (j < to) {
      if (s[j] === '\\') { j += 2; continue; }
      if (s[j] === c) {
        const r = runLength(s, j, c);
        if ((c === '_' || r >= k) && s[j - 1] !== ' ' && j > open) { close = j; break; }
        j += r; continue;
      }
      j++;
    }
    if (close === -1) { i += k; continue; }
    hide.push([i, open], [close, close + k]);
    const cls = c === '_' ? 'em-u' : k === 1 ? 'em-i' : k === 2 ? 'em-b' : 'em-b em-i';
    marks.push([open, close, cls]);
    emphasis(s, open, close, hide, marks); // ênfases aninhadas
    i = close + k;
  }
}

/** Prefixos/sufixos de forçamento de elemento que o modo WYSIWYG esconde. */
export function elementMarkers(type, text) {
  const hide = [];
  const lead = text.length - text.trimStart().length;
  const t = text.trimStart();
  const push = (a, b) => { if (b > a) hide.push([a, b]); };
  switch (type) {
    case 'scene': {
      if (/^\.[^.]/.test(t)) push(lead, lead + 1);
      const num = text.match(/\s*#[\w.-]+#\s*$/);
      if (num) push(num.index, text.length);
      break;
    }
    case 'character': {
      if (t.startsWith('@')) push(lead, lead + 1);
      const dual = text.match(/\s*\^\s*$/);
      if (dual) push(dual.index, text.length);
      break;
    }
    case 'action': if (t.startsWith('!')) push(lead, lead + 1); break;
    case 'transition': { const m = t.match(/^>\s*/); if (m) push(lead, lead + m[0].length); break; }
    case 'centered': {
      const m = t.match(/^>\s*/); if (m) push(lead, lead + m[0].length);
      const e = text.match(/\s*<\s*$/); if (e) push(e.index, text.length);
      break;
    }
    case 'lyrics': if (t.startsWith('~')) push(lead, lead + 1); break;
    case 'synopsis': { const m = t.match(/^=\s*/); if (m) push(lead, lead + m[0].length); break; }
    case 'section': { const m = t.match(/^#+\s*/); if (m) push(lead, lead + m[0].length); break; }
    default: break;
  }
  return hide;
}

/** Chave da página de título ("Title:", "Credit:"…) e o trecho a esconder. */
export function titleKey(text) {
  const m = text.match(/^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ \t]*?):[ \t]*/);
  if (!m || /^\s/.test(text)) return null;
  return { key: m[1].trim().toLowerCase(), hide: [0, m[0].length] };
}
