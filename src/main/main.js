// Processo principal do Electron.
import { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, nativeTheme, Menu } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createBackend } from '../server/backend.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');

const secrets = {
  encrypt: (v) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(v).toString('base64') : Buffer.from(v).toString('base64')),
  decrypt: (v) => (safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(v, 'base64')) : Buffer.from(v, 'base64').toString()),
};

let win = null;
let pendingOpen = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => /\.(fountain|fdx|txt)$/i.test(a)) || null;

if (!app.requestSingleInstanceLock()) app.quit();
// macOS: arquivo aberto pelo Finder (antes ou depois de a janela existir)
app.on('open-file', (e, p) => {
  e.preventDefault();
  if (win) win.webContents.send('open-file', p); else pendingOpen = p;
});
app.on('second-instance', (_e, argv) => {
  const f = argv.find((a) => /\.(fountain|fdx|txt)$/i.test(a));
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); if (f) win.webContents.send('open-file', path.resolve(f)); }
});

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    // no macOS o menu do app é necessário para Cmd+C/V/X/Z/A e Cmd+Q funcionarem
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
  } else {
    Menu.setApplicationMenu(null); // interface mínima: tudo pela paleta de comandos (Ctrl+K)
  }
  const backend = createBackend({ secrets, mode: 'desktop' });

  backend.register('dialog.open', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Roteiros', extensions: ['fountain', 'fdx', 'txt', 'spmd'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = r.filePaths[0];
    if (/\.fdx$/i.test(p)) return { path: p, fdx: await fs.readFile(p, 'utf8') };
    return { path: p };
  });
  backend.register('dialog.saveBytes', async ({ name, base64, ext }) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(backend.paths.library, name), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (r.canceled || !r.filePath) return null;
    await fs.writeFile(r.filePath, Buffer.from(base64, 'base64'));
    return { path: r.filePath };
  });
  backend.register('dialog.saveFountain', async ({ name }) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(backend.paths.library, name), filters: [{ name: 'Fountain', extensions: ['fountain'] }] });
    return r.canceled ? null : { path: r.filePath };
  });
  backend.register('dialog.pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : { path: r.filePaths[0] };
  });
  backend.register('shell.show', async ({ path: p }) => { shell.showItemInFolder(p); return { ok: true }; });
  backend.register('app.pendingOpen', async () => { const p = pendingOpen; pendingOpen = null; return p ? path.resolve(p) : null; });
  backend.register('window.fullscreen', async () => { win.setFullScreen(!win.isFullScreen()); return { ok: true }; });

  ipcMain.handle('cena:call', async (event, name, args, id) => {
    try {
      const result = await backend.call(name, args, { id, emit: (data) => event.sender.send('cena:event', id, data) });
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err.message, code: err.code };
    }
  });

  win = new BrowserWindow({
    width: 1200,
    height: 860,
    minWidth: 560,
    title: 'Cena',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#17171a' : '#fbfaf7',
    autoHideMenuBar: true,
    icon: path.join(root, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false, // o Cena usa o próprio corretor (Hunspell pt-BR/en-US)
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('close', (e) => {
    // dá ao editor a chance de gravar o que falta antes de fechar
    if (win.__flushed) return;
    e.preventDefault();
    win.webContents.send('before-close');
    setTimeout(() => { win.__flushed = true; win.close(); }, 1500);
  });
  ipcMain.on('cena:closed-ok', () => { if (win) { win.__flushed = true; win.close(); } });
  await win.loadFile(path.join(root, 'dist', 'index.html'));
});

app.on('window-all-closed', () => app.quit());
