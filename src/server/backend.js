// Backend do Cena: tudo que precisa do Node (arquivos, nuvem, PDF, Claude).
// É o mesmo para o app Electron (via IPC) e para o modo navegador (via HTTP).
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { CloudSync, sha } from './cloud.js';
import * as claude from './claude.js';
import { toPDF, tablePDF } from '../core/pdf.js';
import { toFDX } from '../core/fdx.js';

const require = createRequire(import.meta.url);
const pkg = JSON.parse(fss.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

function xdg(name, fallback) { return process.env[name] || path.join(os.homedir(), fallback); }
function documentsDir() {
  try { const d = execFileSync('xdg-user-dir', ['DOCUMENTS'], { encoding: 'utf8' }).trim(); if (d && d !== os.homedir()) return d; } catch { /* sem xdg-user-dir */ }
  for (const n of ['Documentos', 'Documents']) { const d = path.join(os.homedir(), n); if (fss.existsSync(d)) return d; }
  return path.join(os.homedir(), 'Documentos');
}

const SECRET_KEYS = [['claude', 'apiKey'], ['cloud', 'webdav', 'password']];
const DEFAULTS = {
  lang: 'pt-BR',
  theme: 'auto',
  paper: 'a4',
  sceneNumbers: true,
  boldScenes: true,
  font: 'courier-prime',
  autocorrect: { accents: true, capitalize: true, elements: true },
  wysiwyg: true,
  spellcheck: true,
  userWords: [],
  languagetool: { enabled: false, url: 'https://api.languagetool.org/v2/check' },
  claude: { provider: 'subscription', cliPath: '', apiKey: '', model: claude.DEFAULT_MODEL, realtime: true, idleSeconds: 20, directEdits: false },
  cloud: { provider: 'none', webdav: { url: '', username: '', password: '' }, folder: '' },
  recent: [],
};

function deepMerge(a, b) {
  const out = Array.isArray(a) ? [...a] : { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a && typeof a[k] === 'object' && !Array.isArray(a[k]) ? deepMerge(a[k], v) : v;
  }
  return out;
}
const getIn = (o, ks) => ks.reduce((x, k) => (x == null ? x : x[k]), o);
const setIn = (o, ks, v) => { let x = o; for (const k of ks.slice(0, -1)) x = x[k] ??= {}; x[ks[ks.length - 1]] = v; };

export function createBackend({ secrets = null, mode = 'web', dirs = {} } = {}) {
  const configDir = dirs.config || path.join(xdg('XDG_CONFIG_HOME', '.config'), 'cena');
  const dataDir = dirs.data || path.join(xdg('XDG_DATA_HOME', '.local/share'), 'cena');
  const library = dirs.library || path.join(documentsDir(), 'Roteiros');
  const settingsFile = path.join(configDir, 'settings.json');
  const historyDir = path.join(dataDir, 'historico');
  const cloud = new CloudSync(path.join(dataDir, 'sync.json'));
  const aborts = new Map();
  let settings = null;
  const lastSnapshot = new Map();

  const enc = (v) => (v && secrets ? 'enc:' + secrets.encrypt(v) : v);
  const dec = (v) => (typeof v === 'string' && v.startsWith('enc:') && secrets ? secrets.decrypt(v.slice(4)) : v);

  async function loadSettings() {
    if (settings) return settings;
    let raw = {};
    try { raw = JSON.parse(await fs.readFile(settingsFile, 'utf8')); } catch { /* primeira execução */ }
    settings = deepMerge(DEFAULTS, raw);
    for (const ks of SECRET_KEYS) { try { setIn(settings, ks, dec(getIn(settings, ks)) || ''); } catch { setIn(settings, ks, ''); } }
    return settings;
  }
  async function saveSettings() {
    const copy = structuredClone(settings);
    for (const ks of SECRET_KEYS) setIn(copy, ks, enc(getIn(copy, ks)));
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(settingsFile, JSON.stringify(copy, null, 2), { mode: 0o600 });
  }
  function masked(s) {
    const c = structuredClone(s);
    c.claude.hasApiKey = !!(s.claude.apiKey || process.env.ANTHROPIC_API_KEY);
    c.claude.ready = s.claude.provider === 'subscription' || c.claude.hasApiKey;
    c.claude.apiKey = '';
    c.cloud.webdav.hasPassword = !!s.cloud.webdav.password;
    c.cloud.webdav.password = '';
    return c;
  }
  const claudeCfg = (s) => ({ provider: s.claude.provider, cliPath: s.claude.cliPath, apiKey: s.claude.apiKey, model: s.claude.model, cwd: path.join(dataDir, 'claude') });

  async function writeAtomic(p, text) {
    await fs.mkdir(path.dirname(p), { recursive: true });
    const tmp = path.join(path.dirname(p), `.${path.basename(p)}.${process.pid}.tmp`);
    await fs.writeFile(tmp, text);
    await fs.rename(tmp, p);
  }
  const histDirFor = (p) => path.join(historyDir, sha(path.resolve(p)).slice(0, 16));

  async function snapshot(p, text, force = false) {
    const last = lastSnapshot.get(p) || 0;
    if (!force && Date.now() - last < 5 * 60 * 1000) return;
    lastSnapshot.set(p, Date.now());
    const dir = histDirFor(p);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${Date.now()}.fountain`), text);
    await fs.writeFile(path.join(dir, 'origem.txt'), path.resolve(p));
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.fountain')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 100))) await fs.unlink(path.join(dir, f));
  }
  async function touchRecent(p) {
    const s = await loadSettings();
    s.recent = [path.resolve(p), ...s.recent.filter((r) => r !== path.resolve(p))].slice(0, 15);
    await saveSettings();
  }

  const handlers = {
    async 'app.info'() {
      return { mode, version: pkg.version, library, platform: process.platform, envKey: !!process.env.ANTHROPIC_API_KEY };
    },
    async 'settings.get'() { return masked(await loadSettings()); },
    async 'settings.set'({ patch }) {
      const s = await loadSettings();
      const p = structuredClone(patch);
      // campos secretos vazios significam "manter o valor atual"
      for (const ks of SECRET_KEYS) if (getIn(p, ks) === '' || getIn(p, ks) === undefined) { const cur = getIn(s, ks); if (getIn(p, ks.slice(0, -1))) setIn(p, ks, cur); }
      if (p.claude) { delete p.claude.hasApiKey; delete p.claude.ready; }
      if (p.cloud?.webdav) delete p.cloud.webdav.hasPassword;
      settings = deepMerge(s, p);
      await saveSettings();
      return masked(settings);
    },
    async 'settings.clearSecret'({ which }) {
      const s = await loadSettings();
      if (which === 'claude') s.claude.apiKey = '';
      if (which === 'webdav') s.cloud.webdav.password = '';
      await saveSettings();
      return masked(s);
    },

    async 'dict.get'({ lang }) {
      const pkgName = lang === 'en-US' ? 'dictionary-en' : 'dictionary-pt';
      const dir = path.dirname(require.resolve(pkgName));
      const [aff, dic] = await Promise.all([fs.readFile(path.join(dir, 'index.aff'), 'utf8'), fs.readFile(path.join(dir, 'index.dic'), 'utf8')]);
      return { aff, dic };
    },
    async 'dict.addWord'({ word }) {
      const s = await loadSettings();
      if (!s.userWords.includes(word)) { s.userWords.push(word); await saveSettings(); }
      return { ok: true };
    },

    async 'doc.list'() {
      const s = await loadSettings();
      await fs.mkdir(library, { recursive: true });
      const files = [];
      for (const f of await fs.readdir(library)) {
        if (!/\.(fountain|spmd|txt)$/i.test(f)) continue;
        const st = await fs.stat(path.join(library, f));
        files.push({ path: path.join(library, f), name: f, mtime: st.mtimeMs });
      }
      const recent = [];
      for (const r of s.recent) { try { const st = await fs.stat(r); recent.push({ path: r, name: path.basename(r), mtime: st.mtimeMs }); } catch { /* removido */ } }
      return { library, files: files.sort((a, b) => b.mtime - a.mtime), recent };
    },
    async 'doc.read'({ path: p }) {
      const text = await fs.readFile(p, 'utf8');
      const st = await fs.stat(p);
      await touchRecent(p);
      return { path: path.resolve(p), name: path.basename(p), text, mtime: st.mtimeMs };
    },
    async 'doc.new'({ title } = {}) {
      await fs.mkdir(library, { recursive: true });
      const base = (title || 'Sem título').replace(/[\\/:*?"<>|]/g, '').trim() || 'Sem título';
      let p = path.join(library, `${base}.fountain`);
      for (let n = 2; fss.existsSync(p); n++) p = path.join(library, `${base} ${n}.fountain`);
      await writeAtomic(p, '');
      await touchRecent(p);
      return { path: p, name: path.basename(p), text: '', mtime: Date.now() };
    },
    async 'doc.save'({ path: p, text, snapshot: force }) {
      await writeAtomic(p, text);
      await snapshot(p, text, !!force);
      const st = await fs.stat(p);
      return { path: p, mtime: st.mtimeMs, savedAt: Date.now() };
    },
    async 'doc.rename'({ path: p, name }) {
      const clean = name.replace(/[\\/:*?"<>|]/g, '').trim();
      if (!clean) throw new Error('Nome inválido.');
      const dest = path.join(path.dirname(p), clean.endsWith('.fountain') ? clean : `${clean}.fountain`);
      if (fss.existsSync(dest)) throw new Error('Já existe um arquivo com esse nome.');
      await fs.rename(p, dest);
      const s = await loadSettings();
      s.recent = s.recent.map((r) => (r === p ? dest : r)); await saveSettings();
      return { path: dest, name: path.basename(dest) };
    },
    async 'file.readText'({ path: p }) { return { text: await fs.readFile(p, 'utf8') }; },
    async 'doc.statDisk'({ path: p }) {
      try { const st = await fs.stat(p); return { mtime: st.mtimeMs }; } catch { return null; }
    },

    async 'history.list'({ path: p }) {
      const dir = histDirFor(p);
      let files = [];
      try { files = (await fs.readdir(dir)).filter((f) => f.endsWith('.fountain')); } catch { /* sem histórico */ }
      const out = [];
      for (const f of files.sort().reverse()) {
        const st = await fs.stat(path.join(dir, f));
        out.push({ id: f, at: Number(f.replace('.fountain', '')), size: st.size });
      }
      return out;
    },
    async 'history.read'({ path: p, id }) {
      if (!/^\d+\.fountain$/.test(id)) throw new Error('Versão inválida.');
      return { text: await fs.readFile(path.join(histDirFor(p), id), 'utf8') };
    },

    // listas de produção e plano de filmagem gerados, guardados por documento
    async 'prod.get'({ path: p }) {
      try { return JSON.parse(await fs.readFile(path.join(dataDir, 'producao', `${sha(path.resolve(p)).slice(0, 16)}.json`), 'utf8')); } catch { return null; }
    },
    async 'prod.set'({ path: p, data }) {
      await writeAtomic(path.join(dataDir, 'producao', `${sha(path.resolve(p)).slice(0, 16)}.json`), JSON.stringify(data));
      return { ok: true };
    },

    async 'cloud.push'({ path: p, text }) {
      const s = await loadSettings();
      return cloud.push(s.cloud, p, text);
    },
    async 'cloud.check'({ path: p, text }) {
      const s = await loadSettings();
      return cloud.check(s.cloud, p, text);
    },
    async 'cloud.accept'({ path: p, text, etag }) {
      const s = await loadSettings();
      await cloud.accept(s.cloud, p, text, etag);
      return { ok: true };
    },
    async 'cloud.test'({ cfg }) {
      const s = await loadSettings();
      const c = deepMerge(s.cloud, cfg || {});
      if (cfg?.webdav && !cfg.webdav.password) c.webdav.password = s.cloud.webdav.password;
      return cloud.test(c);
    },

    async 'export.file'({ format, text, options = {} }) {
      const s = await loadSettings();
      const opts = { paper: s.paper, lang: s.lang, sceneNumbers: s.sceneNumbers, boldScenes: s.boldScenes, font: s.font, ...options };
      if (format === 'pdf') return { mime: 'application/pdf', ext: 'pdf', base64: (await toPDF(text, opts)).toString('base64') };
      if (format === 'fdx') return { mime: 'application/xml', ext: 'fdx', base64: Buffer.from(toFDX(text)).toString('base64') };
      if (format === 'fountain') return { mime: 'text/plain', ext: 'fountain', base64: Buffer.from(text).toString('base64') };
      throw new Error(`Formato desconhecido: ${format}`);
    },
    async 'export.table'(table) {
      return { mime: 'application/pdf', ext: 'pdf', base64: (await tablePDF(table)).toString('base64') };
    },

    async 'grammar.languagetool'({ text }) {
      const s = await loadSettings();
      if (!s.languagetool.enabled) return { matches: [] };
      const body = new URLSearchParams({ text, language: s.lang, disabledRules: 'WHITESPACE_RULE,UPPERCASE_SENTENCE_START' });
      const res = await fetch(s.languagetool.url, { method: 'POST', body, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`LanguageTool respondeu ${res.status}`);
      const j = await res.json();
      return { matches: j.matches.map((m) => ({ offset: m.offset, length: m.length, message: m.message, replacements: m.replacements.slice(0, 4).map((r) => r.value), rule: m.rule?.issueType })) };
    },

    async 'claude.analyze'(args, ctx) { const s = await loadSettings(); return claude.analyze(claudeCfg(s), { ...args, paper: s.paper, lang: s.lang }, ctx); },
    async 'claude.grammar'(args, ctx) { const s = await loadSettings(); return claude.grammar(claudeCfg(s), args, ctx); },
    async 'claude.breakdown'(args, ctx) { const s = await loadSettings(); return claude.breakdown(claudeCfg(s), { ...args, paper: s.paper, lang: s.lang }, ctx); },
    async 'claude.schedule'(args, ctx) { const s = await loadSettings(); return claude.schedule(claudeCfg(s), { ...args, paper: s.paper, lang: s.lang }, ctx); },
    async 'claude.chat'(args, ctx) { const s = await loadSettings(); return claude.chat(claudeCfg(s), args, ctx); },
    async 'claude.edit'(args, ctx) { const s = await loadSettings(); return claude.edit(claudeCfg(s), args, ctx); },
    async 'claude.check'(args, ctx) { const s = await loadSettings(); return claude.check(claudeCfg(s), ctx); },
    async 'call.cancel'({ id }) { aborts.get(id)?.abort(); return { ok: true }; },
  };

  /** Ponto de entrada único: chama um handler com suporte a eventos e cancelamento. */
  async function call(name, args = {}, { emit, id } = {}) {
    const h = handlers[name];
    if (!h) throw new Error(`Comando desconhecido: ${name}`);
    const ac = new AbortController();
    if (id) aborts.set(id, ac);
    try {
      return await h(args, { emit: emit || (() => {}), signal: ac.signal });
    } finally {
      if (id) aborts.delete(id);
    }
  }

  return { call, handlers, register: (name, fn) => { handlers[name] = fn; }, paths: { configDir, dataDir, library } };
}
