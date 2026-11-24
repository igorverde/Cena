// Exportação PDF no padrão da indústria (Node, via pdfkit).
import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { parse } from './fountain.js';
import { paginate } from './paginate.js';

const require = createRequire(import.meta.url);

function fontFiles() {
  try {
    const dir = require.resolve('@fontsource/courier-prime/package.json').replace(/package\.json$/, 'files/');
    const f = (w, s) => `${dir}courier-prime-latin-${w}-${s}.woff`;
    const files = { R: f(400, 'normal'), B: f(700, 'normal'), I: f(400, 'italic'), BI: f(700, 'italic') };
    if (Object.values(files).every((p) => fs.existsSync(p))) return files;
  } catch { /* sem Courier Prime: usa Courier padrão */ }
  return null;
}

const PT = 72;
const LINE = 12;

function collect(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function setupFonts(doc, font) {
  const files = font === 'courier' ? null : fontFiles();
  if (files) {
    for (const [k, p] of Object.entries(files)) doc.registerFont(k, p);
    return { R: 'R', B: 'B', I: 'I', BI: 'BI' };
  }
  return { R: 'Courier', B: 'Courier-Bold', I: 'Courier-Oblique', BI: 'Courier-BoldOblique' };
}

function drawSegs(doc, F, segs, x, y) {
  let cx = x;
  for (const s of segs) {
    const f = s.bold && s.italic ? F.BI : s.bold ? F.B : s.italic ? F.I : F.R;
    doc.font(f).fontSize(12);
    doc.text(s.text, cx, y, { lineBreak: false, underline: !!s.underline });
    cx += doc.widthOfString(s.text);
  }
  return cx - x;
}

function drawLine(doc, F, ln, y, spec) {
  if (!ln) return;
  if (ln.type === 'dual') { for (const d of ln.dual) if (d) drawLine(doc, F, d, y, spec); return; }
  const txt = ln.segs.map((s) => s.text).join('');
  const width = txt.length * 7.2; // Courier: 0,6 em por caractere
  let x = ln.x * PT;
  if (ln.align === 'right') x = (ln.x + ln.w / 10) * PT - width;
  if (ln.align === 'center') x = (ln.x + ln.w / 20) * PT - width / 2;
  drawSegs(doc, F, ln.segs, x, y);
  if (ln.sceneNumber) {
    doc.font(F.R).fontSize(12);
    const n = String(ln.sceneNumber);
    doc.text(n, spec.left * PT - (n.length + 3) * 7.2, y, { lineBreak: false });
    doc.text(n, (spec.paper.w - spec.right) * PT + 1.5 * 7.2, y, { lineBreak: false });
  }
}

function titlePage(doc, F, title, spec) {
  const W = spec.paper.w * PT, H = spec.paper.h * PT;
  const get = (k) => (title[k] || []).filter(Boolean);
  const center = (lines, y) => {
    for (const l of lines) {
      doc.font(F.R).fontSize(12);
      const segs = [{ text: l.replace(/[*_]/g, '') }];
      const w = segs[0].text.length * 7.2;
      drawSegs(doc, F, segs, (W - w) / 2, y);
      y += LINE;
    }
    return y;
  };
  let y = H * 0.36;
  const t = get('title');
  if (t.length) {
    doc.font(F.B);
    for (const l of t) {
      const txt = l.replace(/[*_]/g, '').toUpperCase();
      drawSegs(doc, F, [{ text: txt, bold: true, underline: true }], (W - txt.length * 7.2) / 2, y);
      y += LINE;
    }
    y += LINE * 2;
  }
  y = center(get('credit'), y);
  y += LINE;
  y = center([...get('author'), ...get('authors')], y);
  y += LINE * 2;
  center(get('source'), y);
  const bottom = [...get('contact'), ...get('copyright')];
  let by = H - spec.bottom * PT - bottom.length * LINE;
  for (const l of bottom) { drawSegs(doc, F, [{ text: l }], spec.left * PT, by); by += LINE; }
  const right = [...get('draft date'), ...get('date'), ...get('notes')];
  let ry = H - spec.bottom * PT - right.length * LINE;
  for (const l of right) { drawSegs(doc, F, [{ text: l }], W - spec.right * PT - l.length * 7.2, ry); ry += LINE; }
}

/** Gera o PDF do roteiro. options: { paper, lang, sceneNumbers, boldScenes, font } */
export async function toPDF(text, options = {}) {
  const parsed = parse(text);
  const pag = paginate(parsed, options);
  const { spec } = pag;
  const doc = new PDFDocument({
    size: [spec.paper.w * PT, spec.paper.h * PT], margin: 0, autoFirstPage: false,
    info: { Title: (parsed.title.title || ['Roteiro'])[0].replace(/[*_]/g, ''), Author: (parsed.title.author || parsed.title.authors || [''])[0], Creator: 'Cena' },
  });
  const done = collect(doc);
  const F = setupFonts(doc, options.font);
  if (Object.keys(parsed.title).length) { doc.addPage(); titlePage(doc, F, parsed.title, spec); }
  for (const page of pag.pages) {
    doc.addPage();
    if (page.number > 1) {
      const n = `${page.number}.`;
      doc.font(F.R).fontSize(12).text(n, (spec.paper.w - spec.right) * PT - n.length * 7.2, 0.5 * PT, { lineBreak: false });
    }
    page.lines.forEach((ln, i) => drawLine(doc, F, ln, spec.top * PT + i * LINE, spec));
  }
  doc.end();
  return done;
}

/** PDF simples de tabela (listas de produção e plano de filmagem). */
export async function tablePDF({ title, subtitle, columns, rows, landscape = true }) {
  const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 36 });
  const done = collect(doc);
  const F = setupFonts(doc);
  const W = doc.page.width - 72;
  doc.font(F.B).fontSize(14).text(title, 36, 36);
  if (subtitle) doc.font(F.R).fontSize(9).fillColor('#555').text(subtitle).fillColor('#000');
  doc.moveDown(0.6);
  const weights = columns.map((c) => c.weight || 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => (w / total) * W);
  const drawRow = (cells, bold) => {
    doc.font(bold ? F.B : F.R).fontSize(8);
    const h = Math.max(...cells.map((c, i) => doc.heightOfString(String(c ?? ''), { width: widths[i] - 6 }))) + 6;
    if (doc.y + h > doc.page.height - 36) { doc.addPage(); }
    const y = doc.y;
    let x = 36;
    cells.forEach((c, i) => { doc.text(String(c ?? ''), x + 3, y + 3, { width: widths[i] - 6 }); x += widths[i]; });
    doc.moveTo(36, y + h).lineTo(36 + W, y + h).lineWidth(0.3).strokeColor('#999').stroke();
    doc.x = 36; doc.y = y + h;
  };
  drawRow(columns.map((c) => c.label), true);
  for (const r of rows) {
    if (r.__section) {
      if (doc.y + 30 > doc.page.height - 36) doc.addPage();
      doc.moveDown(0.5); doc.font(F.B).fontSize(10).text(r.__section, 36, doc.y); doc.moveDown(0.2);
      continue;
    }
    drawRow(columns.map((c) => r[c.key]));
  }
  doc.end();
  return done;
}
