// Estatísticas do roteiro: cenas, oitavos de página, elenco por cena.
import { parse, scenes as sceneList, plain } from './fountain.js';
import { paginate, sceneEighths, formatEighths, pageStarts } from './paginate.js';

export function stats(text, options = {}) {
  const parsed = parse(text);
  const pag = paginate(parsed, options);
  const eighths = sceneEighths(pag);
  const list = sceneList(parsed).map((s, i) => {
    const words = s.elements.reduce((n, e) => n + (e.text ? plain(e.text).split(/\s+/).filter(Boolean).length : 0), 0);
    const dialogueLines = s.elements.filter((e) => e.type === 'dialogue').length;
    return {
      index: i,
      number: s.number,
      heading: s.heading,
      intExt: s.intExt,
      location: s.location.toUpperCase(),
      time: s.time.toUpperCase(),
      line: s.line,
      characters: s.characters,
      eighths: eighths.get(i) || 1,
      pages: formatEighths(eighths.get(i) || 1),
      words,
      dialogueLines,
    };
  });
  const characters = new Map();
  for (const s of list) for (const c of s.characters) {
    const cur = characters.get(c) || { name: c, scenes: 0, eighths: 0 };
    cur.scenes++; cur.eighths += s.eighths;
    characters.set(c, cur);
  }
  const dialogueCount = new Map();
  for (const e of parsed.elements) if (e.type === 'character') dialogueCount.set(e.name, (dialogueCount.get(e.name) || 0) + 1);
  return {
    title: (parsed.title.title || [''])[0].replace(/[*_]/g, ''),
    pages: pag.pages.length,
    minutes: pag.pages.length, // regra prática: 1 página ≈ 1 minuto
    scenes: list,
    characters: [...characters.values()].map((c) => ({ ...c, speeches: dialogueCount.get(c.name) || 0 })).sort((a, b) => b.speeches - a.speeches),
    locations: [...new Set(list.map((s) => s.location))],
    pageStarts: pageStarts(pag),
    hasTitle: Object.keys(parsed.title).length > 0,
  };
}

/** Texto compacto com o resumo de cenas para enviar ao Claude. */
export function sceneTable(st) {
  return st.scenes.map((s) => `#${s.number} | ${s.heading} | ${s.intExt || '-'} | ${s.location || '-'} | ${s.time || '-'} | ${s.pages} pág | elenco: ${s.characters.join(', ') || '-'}`).join('\n');
}
