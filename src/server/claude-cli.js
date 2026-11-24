// Claude pela assinatura (Pro/Max): usa a CLI do Claude Code instalada no computador
// em modo não interativo (`claude -p`), já autenticada com a conta do usuário.
// Sem ferramentas, sem MCP, sem configurações de outros projetos: só o pedido do Cena.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const CANDIDATES = [
  path.join(HOME, '.local/bin/claude'),
  path.join(HOME, '.claude/local/claude'),
  path.join(HOME, '.npm-global/bin/claude'),
  path.join(HOME, '.bun/bin/claude'),
  path.join(HOME, '.volta/bin/claude'),
  '/usr/local/bin/claude',
  '/usr/bin/claude',
  '/opt/homebrew/bin/claude',
];

/** Localiza o executável `claude`. Apps abertos pelo menu nem sempre herdam o PATH do terminal. */
export function findClaude(custom) {
  if (custom) return fs.existsSync(custom) ? custom : null;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'claude');
    if (isExec(p)) return p;
  }
  for (const p of CANDIDATES) if (isExec(p)) return p;
  // nvm: ~/.nvm/versions/node/*/bin/claude
  const nvm = path.join(HOME, '.nvm/versions/node');
  try {
    for (const v of fs.readdirSync(nvm).sort().reverse()) {
      const p = path.join(nvm, v, 'bin/claude');
      if (isExec(p)) return p;
    }
  } catch { /* sem nvm */ }
  return null;
}
function isExec(p) { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } }

export class CLIError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

/**
 * Executa um pedido pela CLI.
 * @param {object} o
 * @param {string} o.system   prompt de sistema
 * @param {string} o.prompt   pedido (enviado pela entrada padrão, sem limite de tamanho de argumento)
 * @param {object} [o.schema] JSON Schema: a resposta vem validada em `data`
 * @param {string} [o.model]  ID completo ou apelido (opus, sonnet, haiku)
 * @param {string} [o.effort] low | medium | high | xhigh | max
 * @param {(t:string)=>void} [o.onText] trechos à medida que chegam
 * @param {AbortSignal} [o.signal]
 * @param {string} [o.cliPath] caminho do executável, se não estiver no PATH
 * @param {string} [o.cwd] pasta de trabalho neutra (evita carregar CLAUDE.md de projetos)
 */
export function runCLI({ system, prompt, schema, model, effort, onText, signal, cliPath, cwd }) {
  const bin = findClaude(cliPath);
  if (!bin) {
    return Promise.reject(new CLIError('Claude Code não encontrado. Instale com "npm install -g @anthropic-ai/claude-code", rode "claude" uma vez no terminal para entrar com sua conta, e tente de novo.', 'no_cli'));
  }
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--tools', '', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config',
    '--disable-slash-commands', '--system-prompt', system,
  ];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  if (cwd) fs.mkdirSync(cwd, { recursive: true });

  return new Promise((resolve, reject) => {
    // grupo de processos próprio, para o cancelamento encerrar também os subprocessos
    const child = spawn(bin, args, { cwd: cwd || os.tmpdir(), env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cena' }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let buf = '';
    let stderr = '';
    let result = null;
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; signal?.removeEventListener('abort', onAbort); fn(v); } };
    const kill = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* já saiu */ } } };
    const onAbort = () => { kill(); done(reject, new CLIError('Cancelado.', 'aborted')); };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta') {
          const d = ev.event.delta;
          if (d.type === 'text_delta' && d.text) onText?.(d.text);
          else if (d.type === 'input_json_delta' && d.partial_json) onText?.(d.partial_json);
        } else if (ev.type === 'result') {
          result = ev;
        }
      }
    });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (e) => done(reject, new CLIError(`Não foi possível executar o Claude Code: ${e.message}`, 'no_cli')));
    child.on('close', (code) => {
      if (!result) return done(reject, explain(stderr || `O Claude Code terminou com código ${code}.`));
      if (result.is_error || result.subtype !== 'success') return done(reject, explain(String(result.result || result.subtype || stderr)));
      if (schema) {
        if (result.structured_output) return done(resolve, { data: result.structured_output });
        try { return done(resolve, { data: JSON.parse(result.result) }); } catch { return done(reject, new CLIError('O Claude não devolveu uma resposta no formato esperado. Tente de novo.', 'format')); }
      }
      done(resolve, { text: result.result || '' });
    });
    child.stdin.on('error', () => {}); // processo pode sair antes de ler tudo
    child.stdin.end(prompt);
  });
}

function explain(msg) {
  const m = String(msg).trim();
  if (/log ?in|logged in|authenticat|\/login|OAuth|credential/i.test(m)) {
    return new CLIError('O Claude Code não está conectado à sua conta. Abra um terminal, rode "claude" e entre com sua assinatura (comando /login).', 'auth');
  }
  if (/usage limit|rate limit|limit reached|resets/i.test(m)) {
    return new CLIError(`Limite de uso da assinatura atingido. ${m.slice(0, 200)}`, 'rate_limit');
  }
  return new CLIError(`Claude Code: ${m.slice(0, 400)}`, 'cli');
}
