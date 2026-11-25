// Salvamento automático na nuvem.
// Provedores: WebDAV (Nextcloud, ownCloud, Box, Koofr, 4shared, Yandex, servidores próprios)
// e "pasta sincronizada" (Dropbox, Google Drive via Insync/rclone, OneDrive, Syncthing, MEGA…).
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { projectOf } from './project.js';

export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

class WebDAV {
  constructor({ url, username, password }) {
    if (!url) throw new Error('Informe a URL WebDAV.');
    this.base = url.endsWith('/') ? url : url + '/';
    this.auth = username ? 'Basic ' + Buffer.from(`${username}:${password || ''}`).toString('base64') : null;
    this.dirs = new Set();
  }
  async req(method, name, { body, headers = {} } = {}) {
    const h = { ...headers };
    if (this.auth) h.Authorization = this.auth;
    const url = this.base + (name ? name.split('/').map(encodeURIComponent).join('/') : '');
    const res = await fetch(url, { method, body, headers: h, signal: AbortSignal.timeout(20000) });
    return res;
  }
  async test() {
    const res = await this.req('PROPFIND', '', { headers: { Depth: '0' } });
    if (res.status === 404) {
      const mk = await this.req('MKCOL', '');
      if (!mk.ok) throw new Error(`Não foi possível criar a pasta remota (${mk.status}).`);
      return { ok: true, created: true };
    }
    if (res.status === 401 || res.status === 403) throw new Error('Usuário ou senha recusados pelo servidor.');
    if (!res.ok && res.status !== 207) throw new Error(`O servidor respondeu ${res.status}.`);
    return { ok: true };
  }
  async stat(name) {
    const res = await this.req('HEAD', name);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HEAD ${res.status}`);
    return { etag: res.headers.get('etag'), modified: Date.parse(res.headers.get('last-modified') || '') || 0 };
  }
  async get(name) {
    const res = await this.req('GET', name);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${res.status}`);
    return { text: await res.text(), etag: res.headers.get('etag') };
  }
  // cria as subpastas remotas (projetos e tratamentos)
  async ensureDirs(name) {
    const parts = name.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const d = parts.slice(0, i).join('/') + '/';
      if (this.dirs.has(d)) continue;
      const r = await this.req('MKCOL', d);
      if (!r.ok && r.status !== 405 && r.status !== 301) throw new Error(`MKCOL ${r.status}`); // 405: já existe
      this.dirs.add(d);
    }
  }
  async put(name, text, etag) {
    if (name.includes('/')) await this.ensureDirs(name);
    const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
    if (etag) headers['If-Match'] = etag;
    const res = await this.req('PUT', name, { body: text, headers });
    if (res.status === 412) return { conflict: true };
    if (res.status === 409) { await this.test(); return this.put(name, text, etag); }
    if (!res.ok) throw new Error(`PUT ${res.status}`);
    let newEtag = res.headers.get('etag');
    if (!newEtag) newEtag = (await this.stat(name))?.etag || null;
    return { etag: newEtag };
  }
}

class Folder {
  constructor({ folder }) {
    if (!folder) throw new Error('Escolha a pasta sincronizada.');
    this.dir = folder;
  }
  async test() {
    await fs.mkdir(this.dir, { recursive: true });
    const probe = path.join(this.dir, '.cena-teste');
    await fs.writeFile(probe, 'ok'); await fs.unlink(probe);
    return { ok: true };
  }
  async stat(name) {
    try {
      const st = await fs.stat(path.join(this.dir, name));
      const text = await fs.readFile(path.join(this.dir, name), 'utf8');
      return { etag: sha(text), modified: st.mtimeMs };
    } catch { return null; }
  }
  async get(name) {
    try { const text = await fs.readFile(path.join(this.dir, name), 'utf8'); return { text, etag: sha(text) }; } catch { return null; }
  }
  async put(name, text, etag) {
    const p = path.join(this.dir, name);
    if (etag) { const cur = await this.stat(name); if (cur && cur.etag !== etag) return { conflict: true }; }
    await fs.mkdir(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp-cena';
    await fs.writeFile(tmp, text); await fs.rename(tmp, p);
    return { etag: sha(text) };
  }
}

export function provider(cfg) {
  if (!cfg || cfg.provider === 'none' || !cfg.provider) return null;
  if (cfg.provider === 'webdav') return new WebDAV(cfg.webdav || {});
  if (cfg.provider === 'folder') return new Folder(cfg);
  throw new Error(`Provedor desconhecido: ${cfg.provider}`);
}

/** Gerencia o estado de sincronização por documento (ETag conhecido, hash enviado). */
export class CloudSync {
  constructor(stateFile) {
    this.stateFile = stateFile;
    this.state = {};
    this.loaded = this.load();
    this.queue = Promise.resolve();
  }
  async load() {
    try { this.state = JSON.parse(await fs.readFile(this.stateFile, 'utf8')); } catch { this.state = {}; }
  }
  async persist() {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    await fs.writeFile(this.stateFile, JSON.stringify(this.state, null, 1));
  }
  /** Nome remoto: arquivos de projeto ficam em "<Projeto>/<arquivo>" (inclusive Tratamentos/). */
  remoteName(localPath) {
    const proj = projectOf(localPath);
    if (!proj) return path.basename(localPath);
    return path.relative(path.dirname(proj), path.resolve(localPath)).split(path.sep).join('/');
  }

  /** Envia o texto para a nuvem. Em caso de conflito, guarda a versão remota ao lado do arquivo local. */
  push(cfg, localPath, text) {
    const job = this.queue.then(() => this._push(cfg, localPath, text));
    this.queue = job.catch(() => {});
    return job;
  }
  async _push(cfg, localPath, text) {
    await this.loaded;
    const p = provider(cfg);
    if (!p) return { status: 'off' };
    const key = `${cfg.provider}:${localPath}`;
    const st = this.state[key] || {};
    const hash = sha(text);
    if (st.hash === hash) return { status: 'synced', at: st.at };
    const name = this.remoteName(localPath);
    let res = await p.put(name, text, st.etag || null);
    let conflictPath = null;
    if (res.conflict) {
      const remote = await p.get(name);
      if (remote && sha(remote.text) !== hash) {
        const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
        conflictPath = localPath.replace(/(\.fountain)?$/, ` (versão da nuvem ${stamp}).fountain`);
        await fs.writeFile(conflictPath, remote.text);
      }
      res = await p.put(name, text, null);
    }
    this.state[key] = { etag: res.etag, hash, at: Date.now() };
    await this.persist();
    return { status: conflictPath ? 'conflict' : 'synced', at: Date.now(), conflictPath };
  }

  /** Verifica se há na nuvem uma versão mais nova que a última sincronizada. */
  async check(cfg, localPath, localText) {
    await this.loaded;
    const p = provider(cfg);
    if (!p) return { status: 'off' };
    const name = this.remoteName(localPath);
    const remote = await p.stat(name);
    if (!remote) return { status: 'absent' };
    const st = this.state[`${cfg.provider}:${localPath}`] || {};
    if (st.etag && remote.etag === st.etag) return { status: 'synced' };
    const r = await p.get(name);
    if (!r || sha(r.text) === sha(localText)) {
      this.state[`${cfg.provider}:${localPath}`] = { etag: r?.etag || remote.etag, hash: sha(localText), at: Date.now() };
      await this.persist();
      return { status: 'synced' };
    }
    return { status: 'remote-changed', text: r.text, etag: r.etag, modified: remote.modified };
  }

  async accept(cfg, localPath, text, etag) {
    this.state[`${cfg.provider}:${localPath}`] = { etag, hash: sha(text), at: Date.now() };
    await this.persist();
  }

  async test(cfg) { const p = provider(cfg); if (!p) throw new Error('Nenhum provedor configurado.'); return p.test(); }
}
