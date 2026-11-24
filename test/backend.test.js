import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createBackend } from '../src/server/backend.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cena-'));
const dirs = { config: path.join(tmp, 'cfg'), data: path.join(tmp, 'data'), library: path.join(tmp, 'Roteiros') };
const be = createBackend({ dirs });
const call = (n, a) => be.call(n, a);

// Servidor WebDAV mínimo (PUT/GET/HEAD/PROPFIND/MKCOL com ETag e If-Match)
function webdavMock() {
  const files = new Map();
  let col = false;
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Basic ' + Buffer.from('ana:segredo').toString('base64')) { res.writeHead(401).end(); return; }
    const name = decodeURIComponent(req.url.replace(/^\/dav\/?/, ''));
    let body = ''; for await (const c of req) body += c;
    const etagOf = (t) => `"${crypto.createHash('md5').update(t).digest('hex')}"`;
    if (req.method === 'PROPFIND') { res.writeHead(col ? 207 : 404).end(); return; }
    if (req.method === 'MKCOL') { col = true; res.writeHead(201).end(); return; }
    const f = files.get(name);
    if (req.method === 'HEAD' || req.method === 'GET') {
      if (!f) { res.writeHead(404).end(); return; }
      res.writeHead(200, { ETag: etagOf(f), 'Last-Modified': new Date().toUTCString() }).end(req.method === 'GET' ? f : undefined); return;
    }
    if (req.method === 'PUT') {
      if (req.headers['if-match'] && (!f || etagOf(f) !== req.headers['if-match'])) { res.writeHead(412).end(); return; }
      files.set(name, body); res.writeHead(f ? 204 : 201, { ETag: etagOf(body) }).end(); return;
    }
    res.writeHead(405).end();
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, files, url: `http://127.0.0.1:${server.address().port}/dav/` })));
}

test('documentos, histórico e listas', async () => {
  const d = await call('doc.new', {});
  assert.match(d.name, /Sem título\.fountain/);
  await call('doc.save', { path: d.path, text: 'INT. CASA - DIA\n\nAção.\n', snapshot: true });
  assert.equal(fs.readFileSync(d.path, 'utf8'), 'INT. CASA - DIA\n\nAção.\n');
  const h = await call('history.list', { path: d.path });
  assert.equal(h.length, 1);
  assert.equal((await call('history.read', { path: d.path, id: h[0].id })).text, 'INT. CASA - DIA\n\nAção.\n');
  await assert.rejects(call('history.read', { path: d.path, id: '../x' }));
  const r = await call('doc.rename', { path: d.path, name: 'Meu filme' });
  assert.ok(fs.existsSync(r.path));
  const list = await call('doc.list');
  assert.equal(list.recent[0].name, 'Meu filme.fountain');
  await call('prod.set', { path: r.path, data: { schedule: { days: [] } } });
  assert.deepEqual(await call('prod.get', { path: r.path }), { schedule: { days: [] } });
});

test('configurações não devolvem segredos', async () => {
  const s = await call('settings.set', { patch: { claude: { apiKey: 'sk-ant-teste' } } });
  assert.equal(s.claude.apiKey, '');
  assert.equal(s.claude.hasApiKey, true);
  const s2 = await call('settings.set', { patch: { claude: { apiKey: '', realtime: false } } }); // vazio = manter
  assert.equal(s2.claude.hasApiKey, true);
  assert.equal(s2.claude.realtime, false);
  const saved = JSON.parse(fs.readFileSync(path.join(dirs.config, 'settings.json'), 'utf8'));
  assert.equal(saved.claude.apiKey, 'sk-ant-teste');
  assert.equal((fs.statSync(path.join(dirs.config, 'settings.json')).mode & 0o777).toString(8), '600');
});

test('nuvem: pasta sincronizada', async () => {
  const folder = path.join(tmp, 'Dropbox');
  await call('settings.set', { patch: { cloud: { provider: 'folder', folder } } });
  await call('cloud.test', {});
  const d = await call('doc.new', { title: 'Pasta' });
  await call('doc.save', { path: d.path, text: 'v1' });
  assert.equal((await call('cloud.push', { path: d.path, text: 'v1' })).status, 'synced');
  assert.equal(fs.readFileSync(path.join(folder, 'Pasta.fountain'), 'utf8'), 'v1');
  // outro computador alterou a cópia da nuvem
  fs.writeFileSync(path.join(folder, 'Pasta.fountain'), 'v1 editado no notebook');
  const chk = await call('cloud.check', { path: d.path, text: 'v1' });
  assert.equal(chk.status, 'remote-changed');
  assert.equal(chk.text, 'v1 editado no notebook');
  // sem aceitar, um envio local gera conflito e preserva a versão remota
  const r = await call('cloud.push', { path: d.path, text: 'v2 local' });
  assert.equal(r.status, 'conflict');
  assert.equal(fs.readFileSync(r.conflictPath, 'utf8'), 'v1 editado no notebook');
  assert.equal(fs.readFileSync(path.join(folder, 'Pasta.fountain'), 'utf8'), 'v2 local');
});

test('nuvem: WebDAV (Nextcloud)', async () => {
  const dav = await webdavMock();
  try {
    await call('settings.set', { patch: { cloud: { provider: 'webdav', webdav: { url: dav.url, username: 'ana', password: 'segredo' } } } });
    assert.deepEqual(await call('cloud.test', {}), { ok: true, created: true });
    const d = await call('doc.new', { title: 'Dav' });
    assert.equal((await call('cloud.push', { path: d.path, text: 'a' })).status, 'synced');
    assert.equal((await call('cloud.push', { path: d.path, text: 'a' })).status, 'synced'); // sem mudança: não reenvia
    assert.equal((await call('cloud.push', { path: d.path, text: 'ab' })).status, 'synced');
    assert.equal(dav.files.get('Dav.fountain'), 'ab');
    dav.files.set('Dav.fountain', 'versão do celular');
    const r = await call('cloud.push', { path: d.path, text: 'abc' });
    assert.equal(r.status, 'conflict');
    assert.equal(fs.readFileSync(r.conflictPath, 'utf8'), 'versão do celular');
    assert.equal(dav.files.get('Dav.fountain'), 'abc');
    await call('settings.set', { patch: { cloud: { webdav: { password: 'errada' } } } });
    await assert.rejects(call('cloud.test', {}), /recusados/);
  } finally { dav.server.close(); }
});

test('exportação', async () => {
  const text = fs.readFileSync(new URL('../examples/exemplo.fountain', import.meta.url), 'utf8');
  for (const f of ['pdf', 'fdx', 'fountain']) {
    const r = await call('export.file', { format: f, text });
    assert.ok(Buffer.from(r.base64, 'base64').length > 100, f);
  }
  const t = await call('export.table', { title: 'Plano', columns: [{ key: 'a', label: 'A' }], rows: [{ __section: 'Diária 1' }, { a: 'x' }] });
  assert.equal(Buffer.from(t.base64, 'base64').subarray(0, 4).toString(), '%PDF');
});

test('Claude sem chave dá erro amigável', async () => {
  const old = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  await call('settings.set', { patch: { claude: { provider: 'api' } } });
  await call('settings.clearSecret', { which: 'claude' });
  await assert.rejects(call('claude.grammar', { passage: 'teste' }), /chave da API/);
  if (old) process.env.ANTHROPIC_API_KEY = old;
});
