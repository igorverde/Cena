// Exportação e importação Final Draft (.fdx), formato XML.
import { parse, inlineSegments, SCENE_RE, isUpperLine } from './fountain.js';

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function textRuns(text) {
  return inlineSegments(text).map((s) => {
    const st = [s.bold && 'Bold', s.italic && 'Italic', s.underline && 'Underline'].filter(Boolean).join('+');
    return `<Text${st ? ` Style="${st}"` : ''}>${xml(s.text)}</Text>`;
  }).join('') || '<Text></Text>';
}

const TYPE = {
  scene: 'Scene Heading', action: 'Action', character: 'Character', parenthetical: 'Parenthetical',
  dialogue: 'Dialogue', transition: 'Transition', centered: 'Action', lyrics: 'Lyrics',
};

function para(e) {
  const type = TYPE[e.type];
  if (!type) return '';
  const attrs = [`Type="${type}"`];
  if (e.type === 'scene' && e.number) attrs.push(`Number="${xml(e.number)}"`);
  if (e.type === 'centered') attrs.push('Alignment="Center"');
  const text = e.type === 'lyrics' ? e.text : e.text;
  // várias linhas viram parágrafos separados no Final Draft (exceto diálogo)
  if (e.type === 'action' && e.text.includes('\n')) {
    return `    <Paragraph ${attrs.join(' ')}>${e.text.split('\n').map((l, i) => (i ? '<Text>\n</Text>' : '') + textRuns(l)).join('')}</Paragraph>\n`;
  }
  return `    <Paragraph ${attrs.join(' ')}>${textRuns(text.replace(/\n/g, ' '))}</Paragraph>\n`;
}

export function toFDX(text) {
  const { title, elements } = parse(text);
  let body = '';
  for (let i = 0; i < elements.length; i++) {
    const e = elements[i];
    if (e.type === 'pagebreak') { if (elements[i + 1]) elements[i + 1].pageBreak = true; continue; }
    if (e.type === 'character' && e.dual === 'left') {
      let inner = '';
      let j = i;
      let seenRight = false;
      for (; j < elements.length; j++) {
        const g = elements[j];
        if (g.type === 'character' && j !== i) { if (seenRight || g.dual !== 'right') break; seenRight = true; }
        if (!['character', 'dialogue', 'parenthetical'].includes(g.type)) break;
        inner += '  ' + para(g);
      }
      body += `    <Paragraph Type="Action"><DualDialogue>\n${inner}    </DualDialogue></Paragraph>\n`;
      i = j - 1;
      continue;
    }
    let p = para(e);
    if (e.pageBreak) p = p.replace('<Paragraph ', '<Paragraph StartsNewPage="Yes" ');
    body += p;
  }
  const tp = [];
  const center = (s) => `      <Paragraph Alignment="Center" Type="Action">${textRuns(s)}</Paragraph>\n`;
  const left = (s) => `      <Paragraph Alignment="Left" Type="Action">${textRuns(s)}</Paragraph>\n`;
  const blank = '      <Paragraph Type="Action"><Text></Text></Paragraph>\n';
  if (Object.keys(title).length) {
    for (let k = 0; k < 16; k++) tp.push(blank);
    for (const l of title.title || []) tp.push(center(l));
    tp.push(blank);
    for (const k of ['credit', 'author', 'authors', 'source']) for (const l of title[k] || []) { tp.push(center(l)); }
    for (let k = 0; k < 20; k++) tp.push(blank);
    for (const k of ['draft date', 'date', 'contact', 'copyright', 'notes']) for (const l of title[k] || []) tp.push(left(l));
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<FinalDraft DocumentType="Script" Template="No" Version="5">
  <Content>
${body}  </Content>
  <TitlePage>
    <Content>
${tp.join('')}    </Content>
  </TitlePage>
</FinalDraft>
`;
}

const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');

function readText(inner) {
  let out = '';
  for (const m of inner.matchAll(/<Text([^>]*)>([\s\S]*?)<\/Text>|<Text[^>]*\/>/g)) {
    if (m[2] === undefined) continue;
    let t = unxml(m[2]);
    const style = (m[1].match(/Style="([^"]*)"/) || [])[1] || '';
    if (t.trim()) {
      if (/Underline/.test(style)) t = `_${t}_`;
      if (/Bold/.test(style) && /Italic/.test(style)) t = `***${t}***`;
      else if (/Bold/.test(style)) t = `**${t}**`;
      else if (/Italic/.test(style)) t = `*${t}*`;
    }
    out += t;
  }
  return out;
}

/** Importa .fdx e devolve texto Fountain. */
export function fromFDX(xmlText) {
  const content = (xmlText.match(/<Content>([\s\S]*?)<\/Content>/) || [])[1] || '';
  const out = [];
  const titleXml = (xmlText.match(/<TitlePage>[\s\S]*?<Content>([\s\S]*?)<\/Content>/) || [])[1];
  if (titleXml) {
    const lines = [...titleXml.matchAll(/<Paragraph([^>]*)>([\s\S]*?)<\/Paragraph>/g)].map((m) => readText(m[2]).trim()).filter(Boolean);
    if (lines.length) {
      out.push(`Title: ${lines[0]}`);
      if (lines[1]) out.push(`Credit: ${lines[1]}`);
      if (lines[2]) out.push(`Author: ${lines[2]}`);
      if (lines.length > 3) out.push(`Contact:`, ...lines.slice(3).map((l) => `    ${l}`));
      out.push('');
    }
  }
  const emit = (type, text, number, dualRight) => {
    const t = text.replace(/\s+$/, '');
    switch (type) {
      case 'Scene Heading': {
        const h = t.toUpperCase();
        out.push('', (SCENE_RE.test(h) ? h : `.${h}`) + (number ? ` #${number}#` : ''), '');
        break;
      }
      case 'Character': {
        let c = t.toUpperCase();
        if (!isUpperLine(c)) c = `@${c}`;
        if (out.length && out[out.length - 1] !== '') out.push('');
        out.push(c + (dualRight ? ' ^' : ''));
        break;
      }
      case 'Parenthetical': out.push(t.startsWith('(') ? t : `(${t})`); break;
      case 'Dialogue': out.push(...t.split('\n')); break;
      case 'Lyrics': out.push(`~${t}`); break;
      case 'Transition': {
        const u = t.toUpperCase();
        out.push('', /(TO|PARA):$/.test(u) ? u : `> ${u}`, '');
        break;
      }
      case 'Shot': out.push('', `.${t.toUpperCase()}`, ''); break;
      case 'Cast List': case 'General': case 'Action': default: {
        const lines = t.split('\n');
        if (out.length && out[out.length - 1] !== '') out.push('');
        for (const l of lines) out.push(SCENE_RE.test(l) || (isUpperLine(l) && l.trim().length < 40) ? `!${l}` : l);
        out.push('');
      }
    }
  };
  // o bloco <Paragraph><DualDialogue>…</DualDialogue></Paragraph> vira só <DualDialogue>
  const body = content
    .replace(/<Paragraph[^>]*>\s*<DualDialogue>/g, '<DualDialogue>')
    .replace(/<\/DualDialogue>\s*<\/Paragraph>/g, '</DualDialogue>');
  const re = /<DualDialogue>([\s\S]*?)<\/DualDialogue>|<Paragraph([^>]*)>([\s\S]*?)<\/Paragraph>/g;
  let m;
  while ((m = re.exec(body))) {
    if (m[1] !== undefined) {
      let chars = 0;
      for (const p of m[1].matchAll(/<Paragraph([^>]*)>([\s\S]*?)<\/Paragraph>/g)) {
        const type = (p[1].match(/Type="([^"]*)"/) || [])[1];
        if (type === 'Character') chars++;
        emit(type, readText(p[2]), null, type === 'Character' && chars === 2);
      }
      continue;
    }
    const type = (m[2].match(/Type="([^"]*)"/) || [])[1] || 'Action';
    if (/StartsNewPage="Yes"/.test(m[2])) out.push('', '===', '');
    emit(type, readText(m[3]), (m[2].match(/Number="([^"]*)"/) || [])[1]);
  }
  const text = out.join('\n');
  return text.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').trimEnd() + '\n';
}
