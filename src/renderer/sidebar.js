// Barra lateral do projeto (série): episódios, bíblia e tratamentos. Fica oculta até ser chamada.
import { h, toast, prompt, confirmBox } from './ui.js';
import { call } from './platform.js';

export function createSidebar({ root, getProject, getCurrentPath, onOpen, onChanged, actions }) {
  function render() {
    const p = getProject();
    document.body.classList.toggle('has-project', !!p);
    if (!p) { root.replaceChildren(); document.body.classList.remove('sidebar-open'); return; }
    const cur = getCurrentPath();
    const total = p.episodes.reduce((n, e) => n + (e.pages || 0), 0);
    const item = (e, i) => h('li', { class: `ep ${e.path === cur ? 'active' : ''}` },
      h('button', { class: 'ep-open', onclick: () => onOpen(e.path), title: e.file },
        h('span', { class: 'ep-n' }, String(e.n).padStart(2, '0')),
        h('span', { class: 'ep-title' }, e.title),
        h('span', { class: 'ep-pages' }, e.pages ? `${e.pages}p` : '')),
      h('span', { class: 'ep-actions' },
        h('button', { class: 'icon', title: 'Subir', disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
        h('button', { class: 'icon', title: 'Descer', disabled: i === p.episodes.length - 1, onclick: () => move(i, 1) }, '↓'),
        h('button', { class: 'icon', title: 'Renomear', onclick: () => rename(e) }, '✎'),
        h('button', { class: 'icon', title: 'Retirar do projeto (vai para a pasta Arquivados)', onclick: () => archive(e) }, '⌫')));
    root.replaceChildren(
      h('header', {},
        h('div', {}, h('div', { class: 'proj-kind' }, 'Projeto'), h('div', { class: 'proj-name', title: p.dir }, p.name)),
        h('button', { class: 'icon', title: 'Fechar (Ctrl+\\)', onclick: () => document.body.classList.remove('sidebar-open') }, '×')),
      h('ol', { class: 'eps' }, p.episodes.map(item)),
      h('button', { class: 'add', onclick: add }, '+ Episódio'),
      p.bible ? h('button', { class: `doc ${p.bible === cur ? 'active' : ''}`, onclick: () => onOpen(p.bible) }, 'Bíblia da série') : null,
      h('div', { class: 'grow' }),
      h('p', { class: 'muted small' }, `${p.episodes.length} episódio${p.episodes.length === 1 ? '' : 's'} · ${total} páginas`),
      h('div', { class: 'side-actions' },
        h('button', { onclick: actions.analyzeSeries, title: 'Notas do Claude sobre continuidade e arcos da temporada' }, 'Analisar a temporada'),
        h('button', { onclick: actions.saveDraft, title: 'Congela uma cópia de todos os roteiros' }, 'Salvar tratamento'),
        h('button', { onclick: actions.drafts }, 'Tratamentos…'),
        h('button', { onclick: actions.exportSeason }, 'PDF da temporada')));
  }

  async function refresh() { await onChanged(); render(); }

  async function add() {
    const p = getProject();
    const title = await prompt('Novo episódio', `Episódio ${p.episodes.length + 1}`, 'Título do episódio');
    if (!title) return;
    const r = await call('project.addEpisode', { dir: p.dir, title });
    await refresh();
    onOpen(r.path);
  }
  async function rename(e) {
    const title = await prompt('Renomear episódio', e.title);
    if (!title || title === e.title) return;
    await actions.beforeFileChange();
    try {
      const r = await call('project.renameEpisode', { dir: getProject().dir, file: e.file, title });
      await refresh();
      if (getCurrentPath() === e.path) onOpen(r.path, { silent: true });
    } catch (err) { toast(err.message, { error: true }); }
  }
  async function move(i, d) {
    const p = getProject();
    const files = p.episodes.map((e) => e.file);
    [files[i], files[i + d]] = [files[i + d], files[i]];
    await actions.beforeFileChange();
    const cur = getCurrentPath();
    const { moved } = await call('project.reorder', { dir: p.dir, files });
    await refresh();
    // o arquivo aberto pode ter sido renomeado (número no nome)
    const curFile = cur && cur.startsWith(p.dir) ? cur.slice(p.dir.length + 1) : null;
    if (curFile && moved[curFile]) onOpen(`${p.dir}/${moved[curFile]}`, { silent: true });
  }
  async function archive(e) {
    const ok = await confirmBox('Retirar episódio', `"${e.title}" sai do projeto e o arquivo vai para a pasta Arquivados (nada é apagado). Continuar?`,
      [{ label: 'Cancelar', value: false }, { label: 'Retirar', value: true, primary: true }]);
    if (!ok) return;
    await actions.beforeFileChange();
    await call('project.archive', { dir: getProject().dir, file: e.file });
    await refresh();
    if (getCurrentPath() === e.path) { const p = getProject(); if (p.episodes[0]) onOpen(p.episodes[0].path); else if (p.bible) onOpen(p.bible); }
  }

  return { render, refresh };
}
