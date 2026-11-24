// Diagramação no padrão da indústria: Courier 12pt, 10 caracteres e 6 linhas
// por polegada. Gera páginas de linhas posicionadas, usadas pelo PDF e pela
// contagem de oitavos de página do plano de filmagem.
import { inlineSegments } from './fountain.js';

export const PAPER = {
  letter: { w: 8.5, h: 11 },
  a4: { w: 8.27, h: 11.69 },
};

const STRINGS = {
  'pt-BR': { more: '(MAIS)', contd: '(CONT.)' },
  'en-US': { more: '(MORE)', contd: "(CONT'D)" },
};

export function layoutSpec(paper = 'a4') {
  const p = PAPER[paper] || PAPER.a4;
  const left = 1.5, right = 1;
  const actionW = Math.floor((p.w - left - right) * 10);
  return {
    paper: p,
    top: 1, bottom: 1, left, right,
    linesPerPage: Math.floor((p.h - 2) * 6),
    el: {
      action: { x: left, w: actionW },
      scene: { x: left, w: actionW },
      character: { x: 3.7, w: Math.min(38, Math.floor((p.w - 3.7 - right) * 10)) },
      parenthetical: { x: 3.1, w: 26 },
      dialogue: { x: 2.5, w: 35 },
      lyrics: { x: 2.5, w: 35 },
      transition: { x: left, w: actionW, align: 'right' },
      centered: { x: left, w: actionW, align: 'center' },
      // diálogo duplo: duas colunas
      dualL: { character: { x: 2.3, w: 24 }, parenthetical: { x: 1.8, w: 22 }, dialogue: { x: 1.5, w: 27 } },
      dualR: { character: { x: 5.3, w: 20 }, parenthetical: { x: 4.8, w: 22 }, dialogue: { x: 4.5, w: 27 } },
    },
  };
}

/** Quebra de linha preservando estilos. Retorna array de linhas, cada uma com segmentos. */
export function wrapSegments(text, width) {
  const out = [];
  const paras = text.split('\n');
  for (let pi = 0; pi < paras.length; pi++) {
    const para = paras[pi];
    const segs = inlineSegments(para);
    const chars = [];
    for (const s of segs) for (const ch of s.text) chars.push({ ch, s });
    if (!chars.length) { out.push(Object.assign([], { para: pi })); continue; }
    let start = 0;
    while (start < chars.length) {
      let end = Math.min(start + width, chars.length);
      if (end < chars.length) {
        let sp = -1;
        for (let k = end; k > start; k--) if (chars[k].ch === ' ') { sp = k; break; }
        if (sp > start) end = sp;
      }
      const slice = chars.slice(start, end);
      while (slice.length && slice[slice.length - 1].ch === ' ') slice.pop();
      out.push(Object.assign(regroup(slice), { para: pi }));
      start = end;
      while (start < chars.length && chars[start].ch === ' ') start++;
    }
  }
  return out;
}
function regroup(chars) {
  const segs = [];
  for (const { ch, s } of chars) {
    const last = segs[segs.length - 1];
    if (last && last.bold === s.bold && last.italic === s.italic && last.underline === s.underline) last.text += ch;
    else segs.push({ text: ch, bold: s.bold, italic: s.italic, underline: s.underline });
  }
  return segs;
}
const segText = (segs) => segs.map((s) => s.text).join('');

/**
 * Converte elementos em blocos (unidades que não devem ser quebradas de forma ruim).
 * Cada bloco: { kind, lines: [{segs, x, w, align, type}], spaceBefore, scene, keepWithNext }
 */
function toBlocks(elements, spec, opts) {
  const blocks = [];
  let sceneIdx = -1;
  // src: linha do texto-fonte de onde vem cada linha impressa (para o editor marcar as páginas)
  const mk = (type, text, geo, extra = {}) =>
    wrapSegments(text, geo.w).map((segs) => ({ segs, x: geo.x, w: geo.w, align: geo.align || 'left', type, ...extra, src: extra.src != null ? extra.src + (segs.para || 0) : undefined }));

  for (let i = 0; i < elements.length; i++) {
    const e = elements[i];
    if (e.type === 'scene') sceneIdx++;
    const base = { scene: sceneIdx };
    switch (e.type) {
      case 'scene': {
        const lines = mk('scene', opts.boldScenes ? `**${esc(e.text)}**` : esc(e.text), spec.el.scene, { sceneNumber: opts.sceneNumbers ? e.number : null, src: e.line });
        blocks.push({ ...base, kind: 'scene', lines, spaceBefore: blocks.length ? (opts.doubleSpaceScenes ? 2 : 1) : 0, keepWithNext: true });
        break;
      }
      case 'action':
        blocks.push({ ...base, kind: 'action', lines: mk('action', e.text, spec.el.action, { src: e.line }), spaceBefore: 1 });
        break;
      case 'transition':
        blocks.push({ ...base, kind: 'transition', lines: mk('transition', esc(e.text), spec.el.transition, { src: e.line }), spaceBefore: 1 });
        break;
      case 'centered':
        blocks.push({ ...base, kind: 'action', lines: mk('centered', e.text, spec.el.centered, { src: e.line }), spaceBefore: 1 });
        break;
      case 'lyrics':
        blocks.push({ ...base, kind: 'action', lines: mk('lyrics', `*${e.text}*`, spec.el.lyrics, { src: e.line }), spaceBefore: 1 });
        break;
      case 'pagebreak':
        blocks.push({ ...base, kind: 'pagebreak', lines: [], spaceBefore: 0 });
        break;
      case 'character': {
        // agrupa personagem + parentéticos + falas num único bloco de diálogo
        const group = [e];
        let j = i + 1;
        while (j < elements.length && ['parenthetical', 'dialogue'].includes(elements[j].type)) group.push(elements[j++]);
        let right = null;
        if (e.dual === 'left' && elements[j] && elements[j].type === 'character' && elements[j].dual === 'right') {
          right = [elements[j]];
          let k = j + 1;
          while (k < elements.length && ['parenthetical', 'dialogue'].includes(elements[k].type)) right.push(elements[k++]);
          j = k;
        }
        const render = (grp, geo) => grp.flatMap((g) => {
          const type = g.type;
          const txt = type === 'character' ? esc(g.text) : g.text;
          return mk(type, txt, geo[type], type === 'character' ? { name: g.name, src: g.line } : { src: g.line });
        });
        if (right) {
          const L = render(group, spec.el.dualL), R = render(right, spec.el.dualR);
          const n = Math.max(L.length, R.length);
          const lines = [];
          for (let k = 0; k < n; k++) lines.push({ dual: [L[k] || null, R[k] || null], type: 'dual' });
          blocks.push({ ...base, kind: 'dual', lines, spaceBefore: 1 });
        } else {
          blocks.push({ ...base, kind: 'dialogue', name: e.name, lines: render(group, spec.el), spaceBefore: 1 });
        }
        i = j - 1;
        break;
      }
      default: break; // seções e sinopses não são impressas
    }
  }
  return blocks;
}
function esc(s) { return s.replace(/([*_\\])/g, '\\$1'); }

/**
 * Pagina o roteiro. Retorna { pages: [{ number, lines: [linha|null] }], sceneLines: Map(sceneIdx -> linhas) }
 */
export function paginate(parsed, options = {}) {
  const opts = { paper: 'a4', lang: 'pt-BR', sceneNumbers: true, boldScenes: true, doubleSpaceScenes: false, ...options };
  const spec = layoutSpec(opts.paper);
  const S = STRINGS[opts.lang] || STRINGS['pt-BR'];
  const blocks = toBlocks(parsed.elements, spec, opts);
  const max = spec.linesPerPage;
  const pages = [];
  let page = [];
  const sceneLines = new Map();
  const newPage = () => { pages.push({ number: pages.length + 1, lines: page }); page = []; };
  const count = (b, n) => sceneLines.set(b.scene, (sceneLines.get(b.scene) || 0) + n);

  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    if (b.kind === 'pagebreak') { if (page.length) newPage(); continue; }
    let space = page.length ? b.spaceBefore : 0;
    const need = space + b.lines.length;
    const room = max - page.length;
    // cabeçalho de cena não fica sozinho no pé da página: o bloco seguinte precisa
    // caber inteiro ou poder ser dividido com o mesmo critério usado mais abaixo
    if (b.keepWithNext && blocks[bi + 1] && page.length && need <= room) {
      const nb = blocks[bi + 1];
      const after = room - need - nb.spaceBefore;
      const fits = nb.kind === 'pagebreak' || nb.lines.length <= after
        || (nb.kind === 'action' && after >= 2 && nb.lines.length - after >= 2)
        || (nb.kind === 'dialogue' && after >= 4);
      if (!fits) { newPage(); bi--; continue; }
    }

    if (need <= room) {
      for (let k = 0; k < space; k++) page.push(null);
      page.push(...b.lines); count(b, space + b.lines.length);
      continue;
    }
    // tenta dividir o bloco
    if (b.kind === 'action' && room - space >= 2 && b.lines.length - (room - space) >= 2) {
      const take = room - space;
      for (let k = 0; k < space; k++) page.push(null);
      page.push(...b.lines.slice(0, take)); count(b, space + take);
      newPage();
      page.push(...b.lines.slice(take)); count(b, b.lines.length - take);
      continue;
    }
    if (b.kind === 'dialogue' && room - space >= 4) {
      // personagem + ao menos 1 linha de fala + (MAIS); quebra só entre frases/linhas
      const lines = b.lines;
      let take = Math.min(lines.length - 1, room - space - 1);
      while (take > 1 && (lines[take - 1].type !== 'dialogue' || lines[take].type === 'character')) take--;
      if (take >= 2 && lines.length - take >= 1) {
        const first = lines.slice(0, take);
        const ch = lines[0];
        for (let k = 0; k < space; k++) page.push(null);
        page.push(...first, { segs: [{ text: S.more }], x: spec.el.character.x, w: spec.el.character.w, align: 'left', type: 'more' });
        count(b, space + take + 1);
        newPage();
        const cont = ch.segs.map((s) => ({ ...s }));
        const name = segText(cont).replace(/\s*\((?:CONT\.|CONT'D|MAIS|MORE)\)/g, '');
        page.push({ ...ch, segs: [{ text: `${name} ${S.contd}` }] }, ...lines.slice(take));
        count(b, lines.length - take + 1);
        continue;
      }
    }
    if (page.length) newPage();
    page.push(...b.lines); count(b, b.lines.length);
    while (page.length > max) { // bloco maior que uma página
      const rest = page.splice(max);
      newPage(); page = rest;
    }
  }
  if (page.length || !pages.length) newPage();
  return { pages, sceneLines, spec };
}

/** Linha do texto-fonte (base 0) em que cada página começa: [{ page, line }]. */
export function pageStarts(pag) {
  const out = [];
  const srcOf = (ln) => (!ln ? null : ln.type === 'dual' ? (ln.dual[0] || ln.dual[1])?.src : ln.src);
  let prevLast = null;
  for (const p of pag.pages) {
    // um parágrafo dividido entre páginas aparece inteiro na anterior:
    // o editor só consegue marcar a página no início de uma linha do texto
    let src = null;
    for (const ln of p.lines) {
      const s = srcOf(ln);
      if (s == null || s === prevLast) continue;
      src = s; break;
    }
    if (src != null) out.push({ page: p.number, line: src });
    for (let i = p.lines.length - 1; i >= 0; i--) { const s = srcOf(p.lines[i]); if (s != null) { prevLast = s; break; } }
  }
  return out;
}

/** Oitavos de página por cena (mínimo 1/8), padrão de plano de filmagem. */
export function sceneEighths(pag) {
  const res = new Map();
  for (const [scene, n] of pag.sceneLines) {
    if (scene < 0) continue;
    res.set(scene, Math.max(1, Math.round((n / pag.spec.linesPerPage) * 8)));
  }
  return res;
}

export function formatEighths(n) {
  const whole = Math.floor(n / 8), rest = n % 8;
  if (!whole) return `${rest}/8`;
  return rest ? `${whole} ${rest}/8` : `${whole}`;
}
