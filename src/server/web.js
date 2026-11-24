#!/usr/bin/env node
// Modo navegador: serve a interface em http://127.0.0.1 e expõe o backend via HTTP.
// Útil para usar o Cena sem o Electron (ou em outro computador da rede, via túnel SSH).
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createBackend } from './backend.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', '..', 'dist');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png', '.map': 'application/json' };

export function startWeb({ port = Number(process.env.PORT) || 4677, host = '127.0.0.1', token = process.env.CENA_TOKEN || crypto.randomBytes(16).toString('hex'), dirs } = {}) {
  const backend = createBackend({ mode: 'web', dirs });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      // proteção contra outros sites chamando a API local
      if (req.headers['x-cena-token'] !== token) { res.writeHead(403).end('token inválido'); return; }
      const name = decodeURIComponent(url.pathname.slice(5));
      let body = '';
      for await (const chunk of req) body += chunk;
      const { args, id } = body ? JSON.parse(body) : {};
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
      const write = (o) => res.write(JSON.stringify(o) + '\n');
      req.on('close', () => { if (!res.writableEnded && id) backend.call('call.cancel', { id }).catch(() => {}); });
      try {
        const result = await backend.call(name, args, { id, emit: (data) => write({ event: data }) });
        write({ ok: true, result });
      } catch (err) {
        write({ ok: false, error: err.message, code: err.code });
      }
      res.end();
      return;
    }
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.normalize(path.join(dist, p));
    if (!file.startsWith(dist)) { res.writeHead(403).end(); return; }
    try {
      const data = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch { res.writeHead(404).end('não encontrado'); }
  });
  return new Promise((resolve) => server.listen(port, host, () => {
    const addr = `http://${host}:${server.address().port}/#token=${token}`;
    resolve({ server, url: addr, backend, token });
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { url } = await startWeb();
  console.log(`Cena rodando em ${url}`);
}
