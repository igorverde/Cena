// Pequenos utilitários de interface (sem framework).

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let toastTimer;
export function toast(msg, { error = false, ms = 3200, action } = {}) {
  const t = document.getElementById('toast');
  t.replaceChildren(...[h('span', {}, msg), action ? h('button', { class: 'link', onclick: () => { t.classList.remove('show'); action.run(); } }, action.label) : null].filter(Boolean));
  t.classList.toggle('error', error);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? ms * 2 : ms);
}

/** Janela modal simples. Retorna { el, close, done } (done: Promise do valor de close). */
export function modal(title, body, { wide = false, onClose } = {}) {
  const back = h('div', { class: 'modal-back' });
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  const close = (v) => { back.remove(); onClose?.(); resolve(v); };
  const box = h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-label': title },
    h('header', {}, h('h2', {}, title), h('button', { class: 'icon', title: 'Fechar (Esc)', onclick: () => close(null) }, '×')),
    body);
  back.append(box);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(null); });
  back.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } });
  document.body.append(back);
  setTimeout(() => (box.querySelector('[autofocus], input, textarea, select, button.primary') || box).focus(), 0);
  return { el: box, close, done };
}

export function confirmBox(title, text, buttons) {
  const m = modal(title, h('div', { class: 'confirm' },
    h('p', {}, text),
    h('div', { class: 'row end' }, buttons.map((b) => h('button', { class: b.primary ? 'primary' : '', onclick: () => m.close(b.value) }, b.label)))));
  return m.done;
}

export function prompt(title, value = '', label = '') {
  const input = h('input', { type: 'text', value, autofocus: true });
  const m = modal(title, h('form', { class: 'confirm', onsubmit: (e) => { e.preventDefault(); m.close(input.value); } },
    label ? h('label', {}, label) : null, input,
    h('div', { class: 'row end' }, h('button', { type: 'button', onclick: () => m.close(null) }, 'Cancelar'), h('button', { class: 'primary', type: 'submit' }, 'OK'))));
  setTimeout(() => { input.focus(); input.select(); }, 0);
  return m.done;
}

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); return fn(...a); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return 'agora';
  if (s < 60) return `há ${s}s`;
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  return new Date(ts).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export function toCSV(columns, rows) {
  const q = (v) => { const s = Array.isArray(v) ? v.join('; ') : String(v ?? ''); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '﻿' + [columns.map((c) => q(c.label)).join(','), ...rows.filter((r) => !r.__section).map((r) => columns.map((c) => q(r[c.key])).join(','))].join('\n');
}

/** Markdown mínimo para as respostas do Claude. */
export function miniMarkdown(src) {
  const lines = esc(src).split('\n');
  let html = '';
  let list = null;
  for (const l of lines) {
    const li = l.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (li) { if (!list) { html += '<ul>'; list = true; } html += `<li>${inline(li[1])}</li>`; continue; }
    if (list) { html += '</ul>'; list = null; }
    const hd = l.match(/^#{1,4}\s+(.*)$/);
    if (hd) html += `<h4>${inline(hd[1])}</h4>`;
    else if (l.trim()) html += `<p>${inline(l)}</p>`;
  }
  if (list) html += '</ul>';
  return html;
  function inline(s) { return s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>').replace(/`([^`]+)`/g, '<code>$1</code>'); }
}
