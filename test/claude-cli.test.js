// Testa o modo "assinatura" com um executável `claude` falso que imita a saída stream-json da CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as claude from '../src/server/claude.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cena-cli-'));
const fake = path.join(dir, 'claude');
const log = path.join(dir, 'args.json');
fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
let stdin = ''; process.stdin.on('data', (c) => stdin += c); process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args, stdin, cwd: process.cwd() }));
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  out({ type: 'system', subtype: 'init' });
  if (process.env.FAKE_MODE === 'nologin') { out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }); return; }
  const schemaIdx = args.indexOf('--json-schema');
  if (schemaIdx >= 0) {
    const data = { corrections: [{ original: 'Tem alguém ai?', replacement: 'Tem alguém aí?', kind: 'acentuacao', explanation: 'aí leva acento' }] };
    const j = JSON.stringify(data);
    for (let i = 0; i < j.length; i += 10) out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: j.slice(i, i + 10) } } });
    out({ type: 'result', subtype: 'success', is_error: false, result: j, structured_output: data });
  } else {
    for (const t of ['Uma ', 'logline ', 'curta.']) out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'Uma logline curta.' });
  }
});
`, { mode: 0o755 });
const cfg = { provider: 'subscription', cliPath: fake, model: 'claude-opus-5-5', cwd: path.join(dir, 'cwd') };
const ctx = (ev = []) => ({ emit: (e) => ev.push(e), signal: new AbortController().signal });
const lastArgs = () => JSON.parse(fs.readFileSync(log, 'utf8'));

test('assinatura: saída estruturada e argumentos da CLI', async () => {
  const r = await claude.grammar(cfg, { passage: 'Tem alguém ai?' }, ctx());
  assert.equal(r.data.corrections[0].replacement, 'Tem alguém aí?');
  const { args, stdin, cwd } = lastArgs();
  for (const f of ['-p', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands']) assert.ok(args.includes(f), f);
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-5-5');
  assert.equal(args[args.indexOf('--effort') + 1], 'low');
  assert.equal(JSON.parse(args[args.indexOf('--json-schema') + 1]).properties.corrections.type, 'array');
  assert.match(args[args.indexOf('--system-prompt') + 1], /assistente de roteiro/);
  assert.match(stdin, /Tem alguém ai\?/);
  assert.equal(fs.realpathSync(cwd), fs.realpathSync(cfg.cwd));
});

test('assinatura: conversa em streaming com histórico', async () => {
  const ev = [];
  const r = await claude.chat(cfg, { text: 'INT. CASA - DIA', history: [{ role: 'user', content: 'Oi' }, { role: 'assistant', content: 'Olá!' }, { role: 'user', content: 'Logline?' }] }, ctx(ev));
  assert.equal(r.text, 'Uma logline curta.');
  assert.equal(ev.map((e) => e.text).join(''), 'Uma logline curta.');
  const { stdin } = lastArgs();
  assert.match(stdin, /<roteiro>/);
  assert.match(stdin, /AUTOR: Logline\?/);
  assert.match(stdin, /VOCÊ \(Claude\): Olá!/);
});

test('assinatura: progresso da decupagem e erro de login', async () => {
  const ev = [];
  await claude.breakdown(cfg, { text: 'INT. CASA - DIA\n\nAção.\n' }, ctx(ev)).catch(() => {});
  assert.ok(ev.some((e) => e.type === 'progress'));
  process.env.FAKE_MODE = 'nologin';
  await assert.rejects(claude.grammar(cfg, { passage: 'x' }, ctx()), (e) => e.code === 'auth' && /\/login/.test(e.message));
  delete process.env.FAKE_MODE;
  await assert.rejects(claude.grammar({ ...cfg, cliPath: path.join(dir, 'nao-existe') }, { passage: 'x' }, ctx()), (e) => e.code === 'no_cli');
});

test('assinatura: cancelamento', async () => {
  const slow = path.join(dir, 'slow');
  fs.writeFileSync(slow, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const t = Date.now();
  await assert.rejects(claude.grammar({ ...cfg, cliPath: slow }, { passage: 'x' }, { signal: ac.signal, emit() {} }), (e) => e.code === 'aborted');
  assert.ok(Date.now() - t < 5000);
});
