// Ponte segura entre a interface e o processo principal.
const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Map();
ipcRenderer.on('cena:event', (_e, id, data) => { const fn = listeners.get(id); if (fn) fn(data); });

contextBridge.exposeInMainWorld('cena', {
  mode: 'desktop',
  async call(name, args, onEvent, givenId) {
    const id = givenId || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    if (onEvent) listeners.set(id, onEvent);
    try {
      const r = await ipcRenderer.invoke('cena:call', name, args, id);
      if (!r.ok) { const err = new Error(r.error); err.code = r.code; throw err; }
      return r.result;
    } finally { listeners.delete(id); }
  },
  callId: () => `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  onOpenFile: (fn) => ipcRenderer.on('open-file', (_e, p) => fn(p)),
  onBeforeClose: (fn) => ipcRenderer.on('before-close', async () => { try { await fn(); } finally { ipcRenderer.send('cena:closed-ok'); } }),
});
