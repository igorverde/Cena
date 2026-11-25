// Projetos: uma pasta com vários roteiros (episódios), a bíblia da série e os tratamentos.
// Tudo em formatos abertos: cena.json (JSON legível), .fountain e .md.
//
//   Minha Série/
//     cena.json                ordem dos episódios e dados do projeto
//     Bíblia da série.md       personagens, arcos e regras do mundo (contexto do Claude)
//     01 - Piloto.fountain     versão mais recente de cada roteiro
//     Tratamentos/<data rótulo>/   cópias congeladas da obra inteira
//     Arquivados/              episódios retirados do projeto (nada é apagado)
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';

export const MANIFEST = 'cena.json';
export const BIBLE = 'Bíblia da série.md';
const DRAFTS = 'Tratamentos';
const ARCHIVE = 'Arquivados';

const clean = (s) => String(s || '').replace(/[\\/:*?"<>|\n\r\t]/g, '').replace(/\s+/g, ' ').trim();
const pad = (n) => String(n).padStart(2, '0');

export function isProject(dir) { return fss.existsSync(path.join(dir, MANIFEST)); }

/** Pasta do projeto que contém este arquivo (ou null). */
export function projectOf(file) {
  let dir = path.dirname(path.resolve(file));
  for (let i = 0; i < 4; i++) {
    // a cópia do cena.json dentro de Tratamentos/<rótulo>/ não é um projeto
    if (isProject(dir) && path.basename(path.dirname(dir)) !== DRAFTS) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

async function writeJSON(p, data) {
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await fs.rename(tmp, p);
}

const BIBLE_TEMPLATE = (name) => `# ${name}

Bíblia da série. O Claude lê este documento em toda conversa, análise e edição
do projeto: quanto mais claro, melhores as notas sobre continuidade e arcos.

## Logline

## Tom e regras do mundo

## Personagens

### NOME
Idade, quem é, o que quer, o que esconde. Como fala.

## Arco da temporada

## Episódios
- Ep. 1:
`;

const episodeTemplate = (project, n, title) => `Title: ${title}
Credit: ${project} — Episódio ${n}
Author:
Draft date: ${new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}

`;

/** Cria um projeto novo dentro de `parent`. */
export async function createProject(parent, name, { episodes = 1 } = {}) {
  const pname = clean(name) || 'Nova série';
  let dir = path.join(parent, pname);
  for (let n = 2; fss.existsSync(dir); n++) dir = path.join(parent, `${pname} ${n}`);
  await fs.mkdir(dir, { recursive: true });
  const manifest = { formato: 'cena-projeto', versao: 1, nome: path.basename(dir), tipo: 'serie', biblia: BIBLE, episodios: [], criado: new Date().toISOString() };
  await fs.writeFile(path.join(dir, BIBLE), BIBLE_TEMPLATE(manifest.nome));
  await writeJSON(path.join(dir, MANIFEST), manifest);
  for (let i = 1; i <= episodes; i++) await addEpisode(dir, i === 1 ? 'Piloto' : `Episódio ${i}`);
  return readProject(dir);
}

/** Transforma uma pasta existente de roteiros em projeto (não move nem renomeia nada). */
export async function adoptFolder(dir) {
  if (isProject(dir)) return readProject(dir);
  const files = (await fs.readdir(dir)).filter((f) => /\.fountain$/i.test(f)).sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }));
  const manifest = { formato: 'cena-projeto', versao: 1, nome: path.basename(dir), tipo: 'serie', biblia: BIBLE, episodios: files.map((f) => ({ arquivo: f, titulo: titleFromFile(f) })), criado: new Date().toISOString() };
  if (!fss.existsSync(path.join(dir, BIBLE))) await fs.writeFile(path.join(dir, BIBLE), BIBLE_TEMPLATE(manifest.nome));
  await writeJSON(path.join(dir, MANIFEST), manifest);
  return readProject(dir);
}

const titleFromFile = (f) => f.replace(/\.fountain$/i, '').replace(/^\d+\s*[-–.]\s*/, '');

/** Lê o projeto e reconcilia com os arquivos da pasta (arquivos novos entram no fim). */
export async function readProject(dir) {
  const mpath = path.join(dir, MANIFEST);
  const manifest = JSON.parse(await fs.readFile(mpath, 'utf8'));
  manifest.episodios ||= [];
  const onDisk = new Set((await fs.readdir(dir)).filter((f) => /\.fountain$/i.test(f)));
  let changed = false;
  const kept = manifest.episodios.filter((e) => onDisk.has(e.arquivo));
  if (kept.length !== manifest.episodios.length) changed = true;
  for (const f of [...onDisk].sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }))) {
    if (!kept.some((e) => e.arquivo === f)) { kept.push({ arquivo: f, titulo: titleFromFile(f) }); changed = true; }
  }
  manifest.episodios = kept;
  if (!manifest.biblia) { manifest.biblia = BIBLE; changed = true; }
  if (changed) await writeJSON(mpath, manifest);
  const episodes = [];
  for (const [i, e] of manifest.episodios.entries()) {
    const p = path.join(dir, e.arquivo);
    const st = await fs.stat(p);
    episodes.push({ n: i + 1, file: e.arquivo, title: e.titulo || titleFromFile(e.arquivo), path: p, mtime: st.mtimeMs });
  }
  const biblePath = path.join(dir, manifest.biblia);
  return {
    dir, name: manifest.nome || path.basename(dir), type: manifest.tipo || 'serie',
    bible: fss.existsSync(biblePath) ? biblePath : null,
    episodes,
  };
}

async function updateManifest(dir, fn) {
  const mpath = path.join(dir, MANIFEST);
  const m = JSON.parse(await fs.readFile(mpath, 'utf8'));
  fn(m);
  await writeJSON(mpath, m);
}

/** Adiciona um episódio (arquivo "NN - Título.fountain") ao fim do projeto. */
export async function addEpisode(dir, title) {
  const proj = fss.existsSync(path.join(dir, MANIFEST)) ? JSON.parse(await fs.readFile(path.join(dir, MANIFEST), 'utf8')) : { episodios: [] };
  const n = (proj.episodios || []).length + 1;
  const t = clean(title) || `Episódio ${n}`;
  let file = `${pad(n)} - ${t}.fountain`;
  for (let k = 2; fss.existsSync(path.join(dir, file)); k++) file = `${pad(n)} - ${t} ${k}.fountain`;
  await fs.writeFile(path.join(dir, file), episodeTemplate(proj.nome || path.basename(dir), n, t));
  await updateManifest(dir, (m) => { m.episodios = [...(m.episodios || []), { arquivo: file, titulo: t }]; });
  return { file, path: path.join(dir, file), title: t };
}

/** Renomeia o episódio (título e arquivo, mantendo o número). */
export async function renameEpisode(dir, file, title) {
  const t = clean(title);
  if (!t) throw new Error('Título inválido.');
  const prefix = (file.match(/^(\d+\s*-\s*)/) || [])[1] || '';
  let next = `${prefix}${t}.fountain`;
  if (next !== file) {
    for (let k = 2; fss.existsSync(path.join(dir, next)); k++) next = `${prefix}${t} ${k}.fountain`;
    await fs.rename(path.join(dir, file), path.join(dir, next));
  }
  await updateManifest(dir, (m) => { for (const e of m.episodios) if (e.arquivo === file) { e.arquivo = next; e.titulo = t; } });
  return { file: next, path: path.join(dir, next) };
}

/** Nova ordem dos episódios (lista de nomes de arquivo). Os números no nome são refeitos. */
export async function reorder(dir, files) {
  const m = JSON.parse(await fs.readFile(path.join(dir, MANIFEST), 'utf8'));
  const byFile = new Map(m.episodios.map((e) => [e.arquivo, e]));
  const ordered = files.map((f) => byFile.get(f)).filter(Boolean);
  for (const e of m.episodios) if (!ordered.includes(e)) ordered.push(e);
  // renomeia em dois passos para não colidir ("02 - A" ↔ "01 - B")
  const renames = [];
  ordered.forEach((e, i) => {
    const want = `${pad(i + 1)} - ${e.titulo || titleFromFile(e.arquivo)}.fountain`;
    if (/^\d+\s*-\s*/.test(e.arquivo) && want !== e.arquivo) renames.push([e, want]);
  });
  for (const [e] of renames) { const tmp = `.renomeando-${e.arquivo}`; await fs.rename(path.join(dir, e.arquivo), path.join(dir, tmp)); e.__tmp = tmp; }
  const moved = {};
  for (const [e, want] of renames) {
    let target = want;
    for (let k = 2; fss.existsSync(path.join(dir, target)); k++) target = want.replace(/\.fountain$/, ` ${k}.fountain`);
    await fs.rename(path.join(dir, e.__tmp), path.join(dir, target));
    moved[e.arquivo] = target; e.arquivo = target; delete e.__tmp;
  }
  m.episodios = ordered;
  await writeJSON(path.join(dir, MANIFEST), m);
  // atualiza "— Episódio N" na página de rosto, quando ela segue o modelo do Cena
  for (const [i, e] of ordered.entries()) {
    const p = path.join(dir, e.arquivo);
    const t = await fs.readFile(p, 'utf8');
    const fixed = t.replace(/^(Credit:.*[—-]\s*Episódio\s+)\d+/m, `$1${i + 1}`);
    if (fixed !== t) await fs.writeFile(p, fixed);
  }
  return moved; // nome antigo -> novo
}

/** Retira o episódio do projeto, movendo o arquivo para Arquivados/. */
export async function archiveEpisode(dir, file) {
  await fs.mkdir(path.join(dir, ARCHIVE), { recursive: true });
  let dest = path.join(dir, ARCHIVE, file);
  for (let k = 2; fss.existsSync(dest); k++) dest = path.join(dir, ARCHIVE, file.replace(/\.fountain$/, ` ${k}.fountain`));
  await fs.rename(path.join(dir, file), dest);
  await updateManifest(dir, (m) => { m.episodios = m.episodios.filter((e) => e.arquivo !== file); });
  return { archived: dest };
}

/** Salva um tratamento: cópia congelada de todos os roteiros, da bíblia e do cena.json. */
export async function saveDraft(dir, label) {
  const stamp = new Date().toISOString().slice(0, 10);
  const name = clean(`${stamp} ${clean(label) || 'Tratamento'}`);
  let dest = path.join(dir, DRAFTS, name);
  for (let k = 2; fss.existsSync(dest); k++) dest = path.join(dir, DRAFTS, `${name} ${k}`);
  await fs.mkdir(dest, { recursive: true });
  const proj = await readProject(dir);
  const files = [MANIFEST, ...proj.episodes.map((e) => e.file), ...(proj.bible ? [path.basename(proj.bible)] : [])];
  for (const f of files) await fs.copyFile(path.join(dir, f), path.join(dest, f));
  return { name: path.basename(dest), dir: dest, files };
}

export async function listDrafts(dir) {
  const root = path.join(dir, DRAFTS);
  let names = [];
  try { names = (await fs.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* nenhum */ }
  const out = [];
  for (const n of names.sort().reverse()) {
    const files = (await fs.readdir(path.join(root, n))).filter((f) => /\.(fountain|md)$/i.test(f));
    out.push({ name: n, files });
  }
  return out;
}

export async function readDraftFile(dir, draft, file) {
  if ([draft, file].some((x) => !x || x.includes('/') || x.includes('..'))) throw new Error('Caminho inválido.');
  return fs.readFile(path.join(dir, DRAFTS, draft, file), 'utf8');
}

/**
 * Contexto da obra para o Claude: bíblia + episódios (exceto `skipPath`, que vai à parte
 * com o texto atual do editor). `full: false` inclui só a bíblia.
 */
export async function seriesContext(dir, { skipPath = null, full = true } = {}) {
  const proj = await readProject(dir);
  const parts = [];
  if (proj.bible && path.resolve(proj.bible) !== path.resolve(skipPath || '')) parts.push(`<biblia_da_serie>\n${await fs.readFile(proj.bible, 'utf8')}\n</biblia_da_serie>`);
  else if (proj.bible) parts.push('<biblia_da_serie>(é o documento aberto no editor, enviado à parte)</biblia_da_serie>');
  const current = proj.episodes.find((e) => path.resolve(e.path) === path.resolve(skipPath || ''));
  if (full) {
    for (const e of proj.episodes) {
      if (e === current) { parts.push(`<episodio numero="${e.n}" titulo="${e.title}" atual="sim">(é o roteiro aberto no editor, enviado à parte)</episodio>`); continue; }
      parts.push(`<episodio numero="${e.n}" titulo="${e.title}">\n${await fs.readFile(e.path, 'utf8')}\n</episodio>`);
    }
  }
  const header = `<projeto nome="${proj.name}" episodios="${proj.episodes.length}"${current ? ` episodio_atual="${current.n}"` : ''}>`;
  return `${header}\n${parts.join('\n\n')}\n</projeto>`;
}

/** Junta a temporada num só Fountain (cada episódio começa numa página nova). */
export async function seasonFountain(dir) {
  const proj = await readProject(dir);
  const out = [`Title: ${proj.name}`, 'Credit: Temporada completa', ''];
  for (const [i, e] of proj.episodes.entries()) {
    let t = await fs.readFile(e.path, 'utf8');
    // remove a página de título do episódio
    const lines = t.split('\n');
    if (/^[A-Za-zÀ-ÿ ]+:/.test(lines[0] || '')) { let k = 0; while (k < lines.length && lines[k].trim() !== '') k++; t = lines.slice(k).join('\n'); }
    if (i) out.push('===', '');
    out.push(`> **EPISÓDIO ${e.n}** <`, `> ${e.title.toUpperCase()} <`, '', t.trim(), '');
  }
  return out.join('\n');
}
