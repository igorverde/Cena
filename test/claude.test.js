// Testa a integração com o Claude contra uma Messages API simulada (streaming SSE).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import * as claude from '../src/server/claude.js';

const script = fs.readFileSync(new URL('../examples/exemplo.fountain', import.meta.url), 'utf8');
let lastBody = null;
let reply = '';
let stopReason = 'end_turn';

const server = http.createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c;
  lastBody = { url: req.url, headers: req.headers, body: JSON.parse(b) };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: lastBody.body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  for (let i = 0; i < reply.length; i += 40) ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: reply.slice(i, i + 40) } });
  ev('content_block_stop', { index: 0 });
  ev('message_delta', { delta: { stop_reason: stopReason }, usage: { output_tokens: 20 } });
  ev('message_stop', {});
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
const cfg = { apiKey: 'sk-ant-teste', model: claude.DEFAULT_MODEL };
const ctx = (events = []) => ({ emit: (e) => events.push(e), signal: new AbortController().signal });
test.after(() => server.close());

test('análise da cena: requisição e saída estruturada', async () => {
  reply = JSON.stringify({ summary: 'Marta se despede.', notes: [{ scene: '2', quote: 'Mais uma noite, meu velho.', kind: 'dialogo', severity: 'sugestao', note: 'Fala forte.', suggestion: '' }] });
  const r = await claude.analyze(cfg, { text: script, scope: 'scene', sceneText: 'INT. CABINE...', sceneNumber: '2' }, ctx());
  assert.equal(r.data.notes[0].quote, 'Mais uma noite, meu velho.');
  const b = lastBody.body;
  assert.match(lastBody.url, /^\/v1\/messages/);
  assert.match(lastBody.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(b.model, 'claude-opus-5-5');
  assert.equal(b.stream, true);
  assert.equal(b.fallbacks, 'default');
  assert.equal(b.output_config.effort, 'low');
  assert.equal(b.output_config.format.type, 'json_schema');
  assert.equal(b.output_config.format.schema.additionalProperties, false);
  assert.equal(b.thinking, undefined);
  assert.equal(b.system[0].cache_control.type, 'ephemeral');
  assert.match(b.messages[0].content[0].text, /<roteiro>/);
  assert.match(b.messages[0].content[1].text, /#1 \| EXT\. CINEMA DE RUA - NOITE \| EXT \| CINEMA DE RUA \| NOITE/);
});

test('plano de filmagem completa oitavos e avisa cenas faltando', async () => {
  reply = JSON.stringify({ days: [{ day: 1, date: '2026-12-01', unit: 'Cinema', call_time: '07:00', wrap_time: '19:00', scenes: [{ number: '1', cast: ['MARTA'], notes: '' }, { number: '3', cast: ['MARTA', 'LUCAS'], notes: '' }], notes: '' }], rationale: 'Mesma locação.', warnings: [] });
  const events = [];
  const r = await claude.schedule(cfg, { text: script, params: { pagesPerDay: 3 } }, ctx(events));
  assert.equal(r.data.days[0].scenes[0].heading, 'EXT. CINEMA DE RUA - NOITE');
  assert.ok(r.data.days[0].eighths > 0);
  assert.match(r.data.warnings.join(), /Cenas fora do plano: 2/);
  assert.ok(events.some((e) => e.type === 'progress'));
  assert.equal(lastBody.body.output_config.effort, 'high');
  assert.equal(lastBody.body.max_tokens, 64000);
});

test('conversa em streaming e modelo Haiku sem fallback', async () => {
  reply = 'Uma projecionista solitária vive a última noite de um cinema de rua.';
  const events = [];
  const r = await claude.chat({ ...cfg, model: 'claude-haiku-5-5' }, { text: script, history: [{ role: 'user', content: 'Logline?' }] }, ctx(events));
  assert.equal(r.text, reply);
  assert.equal(events.map((e) => e.text).join(''), reply);
  assert.equal(lastBody.body.fallbacks, undefined);
  assert.equal(lastBody.body.output_config.format, undefined);
});

test('recusa vira mensagem amigável', async () => {
  reply = ''; stopReason = 'refusal';
  await assert.rejects(claude.grammar(cfg, { passage: 'x' }, ctx()), (e) => e.code === 'refusal');
  stopReason = 'end_turn';
});
