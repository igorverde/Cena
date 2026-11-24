// Verificador ortográfico compatível com dicionários Hunspell (.aff/.dic).
// Em vez de expandir todas as formas (10M+ em pt-BR), remove afixos na
// consulta, como o próprio Hunspell faz: carga rápida e pouca memória.

const WORD_RE = /[\p{L}\p{M}][\p{L}\p{M}'’-]*/gu;

export class Speller {
  constructor(affText, dicText) {
    this.sfx = new Map(); // texto adicionado -> [entradas]
    this.pfx = new Map();
    this.rules = new Map();
    this.try = '';
    this.map = [];
    this.rep = [];
    this.forbidden = null;
    this.nosuggest = null;
    this.needaffix = null;
    this.keepcase = null;
    this.user = new Set();
    this._parseAff(affText);
    this._parseDic(dicText);
    this.maxAdd = { SFX: 0, PFX: 0 };
    for (const k of this.sfx.keys()) this.maxAdd.SFX = Math.max(this.maxAdd.SFX, k.length);
    for (const k of this.pfx.keys()) this.maxAdd.PFX = Math.max(this.maxAdd.PFX, k.length);
  }

  _parseAff(text) {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/\s+#.*$/, '').trim();
      if (!line || line.startsWith('#')) continue;
      const p = line.split(/\s+/);
      switch (p[0]) {
        case 'TRY': this.try = p[1] || ''; continue;
        case 'MAP': if (p.length > 1 && !/^\d+$/.test(p[1])) this.map.push([...p[1]]); continue;
        case 'REP': if (p.length > 2) this.rep.push([p[1].replace(/_/g, ' '), p[2].replace(/_/g, ' ')]); continue;
        case 'FORBIDDENWORD': this.forbidden = p[1]; continue;
        case 'NOSUGGEST': this.nosuggest = p[1]; continue;
        case 'NEEDAFFIX': this.needaffix = p[1]; continue;
        case 'KEEPCASE': this.keepcase = p[1]; continue;
      }
      if (p[0] !== 'PFX' && p[0] !== 'SFX') continue;
      const flag = p[1];
      if (!this.rules.has(flag)) { this.rules.set(flag, { type: p[0], cross: p[2] === 'Y' }); continue; }
      if (p.length < 4) continue;
      const strip = p[2] === '0' ? '' : p[2];
      let [add, cont] = p[3].split('/');
      if (add === '0') add = '';
      const c = p[4] || '.';
      const cond = c === '.' ? null : new RegExp(p[0] === 'SFX' ? `${c}$` : `^${c}`, 'u');
      const entry = { flag, strip, add, cont: cont || '', cond, cross: this.rules.get(flag).cross };
      const idx = p[0] === 'SFX' ? this.sfx : this.pfx;
      if (!idx.has(add)) idx.set(add, []);
      idx.get(add).push(entry);
    }
  }

  _parseDic(text) {
    this.dic = new Map();
    const lines = text.split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i];
      if (!l) continue;
      const slash = l.indexOf('/');
      const word = (slash === -1 ? l : l.slice(0, slash)).trim();
      const flags = slash === -1 ? '' : l.slice(slash + 1).split(/\s/)[0];
      const prev = this.dic.get(word);
      this.dic.set(word, prev ? prev + flags : flags);
    }
  }

  _hasRoot(root, flag) {
    const f = this.dic.get(root);
    if (f === undefined) return false;
    if (this.forbidden && f.includes(this.forbidden)) return false;
    return flag ? f.includes(flag) : !(this.needaffix && f.includes(this.needaffix));
  }

  // Palavra = raiz + sufixo (com até dois níveis de sufixo).
  _suffixed(word, needFlag, crossOnly) {
    const n = word.length;
    for (let k = 0; k <= Math.min(n - 1, this.maxAdd.SFX); k++) {
      const entries = this.sfx.get(word.slice(n - k));
      if (!entries) continue;
      const base = word.slice(0, n - k);
      for (const e of entries) {
        if (crossOnly && !e.cross) continue;
        const root = base + e.strip;
        if (e.cond && !e.cond.test(root)) continue;
        if (this._hasRoot(root, e.flag) && (!needFlag || this.dic.get(root).includes(needFlag))) return true;
        // segundo nível: root é uma forma sufixada cujo sufixo permite e.flag
        if (!needFlag && this._innerSuffix(root, e.flag)) return true;
      }
    }
    return false;
  }

  _innerSuffix(word, contFlag) {
    const n = word.length;
    for (let k = 1; k <= Math.min(n - 1, this.maxAdd.SFX); k++) {
      const entries = this.sfx.get(word.slice(n - k));
      if (!entries) continue;
      for (const e of entries) {
        if (!e.cont.includes(contFlag)) continue;
        const root = word.slice(0, n - k) + e.strip;
        if ((!e.cond || e.cond.test(root)) && this._hasRoot(root, e.flag)) return true;
      }
    }
    return false;
  }

  _lookup(word) {
    if (this.user.has(word)) return true;
    const f = this.dic.get(word);
    if (f !== undefined) {
      if (this.forbidden && f.includes(this.forbidden)) return false;
      if (!(this.needaffix && f.includes(this.needaffix))) return true;
    }
    if (this._suffixed(word)) return true;
    for (let k = 1; k <= Math.min(word.length - 1, this.maxAdd.PFX); k++) {
      const entries = this.pfx.get(word.slice(0, k));
      if (!entries) continue;
      for (const e of entries) {
        const rest = e.strip + word.slice(k);
        if (e.cond && !e.cond.test(rest)) continue;
        if (this._hasRoot(rest, e.flag)) return true;
        if (e.cross && this._suffixed(rest, e.flag, true)) return true;
      }
    }
    return false;
  }

  correct(word) {
    word = word.replace(/’/g, "'");
    if (!word || /\d/.test(word)) return true;
    if (this._lookup(word)) return true;
    const lower = word.toLocaleLowerCase('pt-BR');
    if (lower !== word) {
      const cap = lower[0].toLocaleUpperCase('pt-BR') + lower.slice(1);
      if (this._lookup(lower) || this._lookup(cap)) return true;
      if (this.user.has(lower)) return true;
    }
    if (word.includes('-')) return word.split('-').every((p) => !p || this.correct(p));
    return false;
  }

  suggest(word, max = 8) {
    const isUpper = word === word.toLocaleUpperCase('pt-BR') && word.length > 1;
    const isCap = !isUpper && word[0] === word[0].toLocaleUpperCase('pt-BR');
    const w = word.toLocaleLowerCase('pt-BR');
    const out = [];
    const seen = new Set([w]);
    const ok = (c) => {
      if (seen.has(c)) return; seen.add(c);
      const f = this.dic.get(c);
      if (f && this.nosuggest && f.includes(this.nosuggest)) return;
      if (c && this._lookup(c)) out.push(c);
    };
    // 1. variações de acento (MAP): o erro mais comum em português
    for (const v of this._mapVariants(w, 3)) ok(v);
    // 2. tabela REP
    for (const [a, b] of this.rep) {
      let i = w.indexOf(a);
      while (i !== -1) { ok(w.slice(0, i) + b + w.slice(i + a.length)); i = w.indexOf(a, i + 1); }
    }
    // 3. distância de edição 1
    const chars = [...new Set(this.try + 'abcdefghijklmnopqrstuvwxyz')];
    for (let i = 0; i <= w.length; i++) {
      if (i < w.length) ok(w.slice(0, i) + w.slice(i + 1));
      if (i < w.length - 1) ok(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2));
      for (const c of chars) {
        if (i < w.length) ok(w.slice(0, i) + c + w.slice(i + 1));
        ok(w.slice(0, i) + c + w.slice(i));
      }
      if (out.length >= max * 2) break;
    }
    // 4. palavra colada: "derepente" -> "de repente"
    for (let i = 2; i < w.length - 1; i++) {
      const a = w.slice(0, i), b = w.slice(i);
      if (this._lookup(a) && this._lookup(b)) out.push(`${a} ${b}`);
    }
    const score = (c) => levenshtein(stripAccents(c), stripAccents(w)) * 2 + levenshtein(c, w) * 0.5 + (/[- ]/.test(c) && !/[- ]/.test(w) ? 1.6 : 0);
    const ranked = [...new Set(out)].sort((a, b) => score(a) - score(b)).slice(0, max);
    return ranked.map((s) => isUpper ? s.toLocaleUpperCase('pt-BR') : isCap ? s[0].toLocaleUpperCase('pt-BR') + s.slice(1) : s);
  }

  _mapVariants(w, maxChanges) {
    const groups = new Map();
    for (const g of this.map) for (const ch of g) groups.set(ch, g.filter((x) => x === x.toLowerCase()));
    const res = [];
    const rec = (i, cur, changes) => {
      if (i === w.length) { if (changes) res.push(cur); return; }
      rec(i + 1, cur + w[i], changes);
      if (changes >= maxChanges) return;
      const g = groups.get(w[i]);
      if (g) for (const alt of g) if (alt !== w[i]) rec(i + 1, cur + alt, changes + 1);
    };
    if (w.length < 25) rec(0, '', 0);
    return res;
  }

  // Correção automática segura: só troca quando a diferença é apenas de
  // acentuação e existe exatamente uma alternativa (ex.: "voce" -> "você").
  autocorrect(word) {
    if (this.correct(word)) return null;
    const w = word.toLocaleLowerCase('pt-BR');
    const alts = this._mapVariants(w, 3).filter((v) => this._lookup(v));
    if (alts.length !== 1) return null;
    const a = alts[0];
    if (word === word.toLocaleUpperCase('pt-BR') && word.length > 1) return a.toLocaleUpperCase('pt-BR');
    if (word[0] !== w[0]) return a[0].toLocaleUpperCase('pt-BR') + a.slice(1);
    return a;
  }

  addWord(word) { this.user.add(word); }
}

export function words(text) {
  const res = [];
  for (const m of text.matchAll(WORD_RE)) {
    let t = m[0].replace(/['’-]+$/, '');
    if (t) res.push({ word: t, index: m.index });
  }
  return res;
}

export function stripAccents(s) { return s.normalize('NFD').replace(/\p{M}/gu, ''); }

export function levenshtein(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
