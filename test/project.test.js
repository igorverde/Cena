import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBackend } from '../src/server/backend.js';
import * as proj from '../src/server/project.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cena-proj-'));
const dirs = { config: path.join(tmp, 'cfg'), data: path.join(tmp, 'data'), library: path.join(tmp, 'Roteiros') };
const be = createBackend({ dirs });
const call = (n, a) => be.call(n, a);

test('criar projeto, episódios, renomear, reordenar e arquivar', async () => {
  const p = await call('project.create', { name: 'A Última Sessão' });
  assert.equal(p.name, 'A Última Sessão');
  assert.ok(fs.existsSync(path.join(p.dir, 'cena.json')));
  assert.ok(fs.existsSync(path.join(p.dir, 'Bíblia da série.md')));
  assert.equal(p.episodes[0].file, '01 - Piloto.fountain');
  const e2 = await call('project.addEpisode', { dir: p.dir, title: 'O Projetor' });
  const e3 = await call('project.addEpisode', { dir: p.dir, title: 'Fim da Sessão' });
  assert.equal(e3.file, '03 - Fim da Sessão.fountain');
  fs.appendFileSync(e3.path, 'INT. CABINE - NOITE\n\nMarta desliga o projetor.\n');
  const r = await call('project.renameEpisode', { dir: p.dir, file: e2.file, title: 'A Lata Perdida' });
  assert.equal(r.file, '02 - A Lata Perdida.fountain');
  // o episódio 3 vai para o começo: os números dos arquivos são refeitos
  const { moved } = await call('project.reorder', { dir: p.dir, files: ['03 - Fim da Sessão.fountain', '01 - Piloto.fountain', '02 - A Lata Perdida.fountain'] });
  assert.equal(moved['03 - Fim da Sessão.fountain'], '01 - Fim da Sessão.fountain');
  const p2 = await call('project.open', { dir: p.dir });
  assert.deepEqual(p2.episodes.map((e) => e.file), ['01 - Fim da Sessão.fountain', '02 - Piloto.fountain', '03 - A Lata Perdida.fountain']);
  assert.match(fs.readFileSync(p2.episodes[0].path, 'utf8'), /Marta desliga o projetor/);
  assert.match(fs.readFileSync(p2.episodes[0].path, 'utf8'), /Credit: A Última Sessão — Episódio 1\n/);
  assert.match(fs.readFileSync(p2.episodes[1].path, 'utf8'), /Credit: A Última Sessão — Episódio 2\n/);
  assert.ok(p2.episodes[0].pages >= 1);
  await call('project.archive', { dir: p.dir, file: '03 - A Lata Perdida.fountain' });
  assert.ok(fs.existsSync(path.join(p.dir, 'Arquivados', '03 - A Lata Perdida.fountain')));
  assert.equal((await call('project.open', { dir: p.dir })).episodes.length, 2);
  // arquivo colocado na pasta por fora entra no projeto
  fs.writeFileSync(path.join(p.dir, '09 - Extra.fountain'), 'INT. RUA - DIA\n');
  assert.equal((await call('project.open', { dir: p.dir })).episodes.at(-1).title, 'Extra');
  // abrir um episódio informa o projeto
  assert.equal((await call('doc.read', { path: p2.episodes[1].path })).project, p.dir);
  assert.ok((await call('doc.list')).projects.some((x) => x.dir === p.dir));
});

test('abrir pasta existente como projeto', async () => {
  const d = path.join(tmp, 'Pasta solta');
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'Ep 2.fountain'), 'x'); fs.writeFileSync(path.join(d, 'Ep 10.fountain'), 'y'); fs.writeFileSync(path.join(d, 'notas.txt'), 'z');
  const p = await call('project.adopt', { dir: d });
  assert.deepEqual(p.episodes.map((e) => e.file), ['Ep 2.fountain', 'Ep 10.fountain']);
  assert.ok(p.bible);
});

test('tratamentos e contexto da série', async () => {
  const p = await call('project.create', { name: 'Série B' });
  await call('project.addEpisode', { dir: p.dir, title: 'Dois' });
  const pj = await call('project.open', { dir: p.dir });
  fs.writeFileSync(pj.episodes[0].path, 'INT. CASA - DIA\n\nVersão um.\n');
  fs.appendFileSync(pj.bible, '\nMARTA tem medo do escuro.\n');
  const d = await call('project.saveDraft', { dir: p.dir, label: 'Primeiro tratamento' });
  assert.match(d.name, /^\d{4}-\d{2}-\d{2} Primeiro tratamento$/);
  fs.writeFileSync(pj.episodes[0].path, 'INT. CASA - DIA\n\nVersão dois.\n');
  const list = await call('project.drafts', { dir: p.dir });
  assert.equal(list[0].name, d.name);
  assert.equal((await call('project.readDraft', { dir: p.dir, draft: d.name, file: pj.episodes[0].file })).text, 'INT. CASA - DIA\n\nVersão um.\n');
  await assert.rejects(call('project.readDraft', { dir: p.dir, draft: '..', file: 'cena.json' }));
  const ctx = await proj.seriesContext(p.dir, { skipPath: pj.episodes[1].path });
  assert.match(ctx, /medo do escuro/);
  assert.match(ctx, /Versão dois/);
  assert.match(ctx, /episodio numero="2" titulo="Dois" atual="sim">\(é o roteiro aberto/);
  assert.doesNotMatch(await proj.seriesContext(p.dir, { full: false }), /Versão dois/);
  const season = await proj.seasonFountain(p.dir);
  assert.match(season, /^Title: Série B/);
  assert.match(season, /> \*\*EPISÓDIO 2\*\* <\n> DOIS </);
  const pdf = await call('project.exportPdf', { dir: p.dir });
  assert.equal(Buffer.from(pdf.base64, 'base64').subarray(0, 4).toString(), '%PDF');
  const st = await call('project.stats', { dir: p.dir });
  assert.equal(st.length, 2);
});

test('nuvem: arquivos do projeto vão para a subpasta do projeto', async () => {
  const folder = path.join(tmp, 'Nuvem');
  await call('settings.set', { patch: { cloud: { provider: 'folder', folder } } });
  const p = await call('project.create', { name: 'Série C' });
  const ep = p.episodes[0];
  assert.equal((await call('cloud.push', { path: ep.path, text: 'INT. X - DIA\n' })).status, 'synced');
  assert.equal(fs.readFileSync(path.join(folder, 'Série C', ep.file), 'utf8'), 'INT. X - DIA\n');
  const d = await call('project.saveDraft', { dir: p.dir, label: 'T1' });
  assert.ok(fs.existsSync(path.join(folder, 'Série C', 'Tratamentos', d.name, 'cena.json')));
  await new Promise((r) => setTimeout(r, 100)); // envio do cena.json em segundo plano
  assert.ok(fs.existsSync(path.join(folder, 'Série C', 'cena.json')));
  await call('settings.set', { patch: { cloud: { provider: 'none' } } });
});

test('Claude recebe a série inteira (modo assinatura, CLI falsa)', async () => {
  const fake = path.join(tmp, 'claude');
  const log = path.join(tmp, 'stdin.txt');
  fs.writeFileSync(fake, `#!/usr/bin/env node
let s=''; process.stdin.on('data',c=>s+=c); process.stdin.on('end',()=>{ require('fs').writeFileSync(${JSON.stringify(log)}, s);
const data={summary:'ok',edits:[]}; process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result:JSON.stringify(data),structured_output:data})+'\\n'); });`, { mode: 0o755 });
  await call('settings.set', { patch: { claude: { provider: 'subscription', cliPath: fake } } });
  const p = await call('project.create', { name: 'Série D' });
  await call('project.addEpisode', { dir: p.dir, title: 'Segundo' });
  const pj = await call('project.open', { dir: p.dir });
  fs.writeFileSync(pj.episodes[1].path, 'INT. FAROL - NOITE\n\nO faroleiro some.\n');
  await call('claude.edit', { path: pj.episodes[0].path, text: 'INT. CASA - DIA\n', instruction: 'teste' });
  const sent = fs.readFileSync(log, 'utf8');
  assert.match(sent, /<projeto nome="Série D" episodios="2" episodio_atual="1">/);
  assert.match(sent, /O faroleiro some/);
  assert.match(sent, /<biblia_da_serie>/);
  assert.match(sent, /<roteiro episodio_atual="sim">/);
  // roteiro avulso: sem contexto de série
  await call('claude.edit', { path: path.join(tmp, 'avulso.fountain'), text: 'INT. X - DIA\n', instruction: 'teste' });
  assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /<projeto/);
});
