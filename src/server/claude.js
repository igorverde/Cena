// Integração com o Claude (API da Anthropic): análise em tempo real,
// revisão gramatical, listas de produção (decupagem), plano de filmagem e conversa.
import Anthropic from '@anthropic-ai/sdk';
import { stats, sceneTable } from '../core/stats.js';
import { runCLI, findClaude, CLIError } from './claude-cli.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';

const SYSTEM = `Você é o assistente de roteiro integrado ao Cena, um editor de roteiros para cinema.
O roteiro está no formato Fountain (texto puro): cabeçalhos de cena começam com INT./EXT.,
nomes de personagem ficam em maiúsculas numa linha própria seguidos da fala, parentéticos
vêm entre parênteses, transições terminam com "PARA:" ou "TO:", [[notas]] e /* trechos */ não
são impressos.

Seu papel é o de um consultor de roteiro e de um primeiro assistente de direção experiente:
- respeite a voz, o estilo e as escolhas do autor; aponte problemas concretos e úteis, nunca genéricos;
- cite trechos exatamente como estão no texto quando pedirem um trecho;
- escreva no idioma do roteiro (português do Brasil, salvo se o roteiro estiver em outro idioma);
- seja conciso: o autor está escrevendo e lê suas notas de relance.`;

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export class ClaudeError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function client(apiKey) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new ClaudeError('Configure sua chave da API da Anthropic em Configurações → Claude.', 'no_key');
  }
  return new Anthropic(key ? { apiKey: key } : {});
}

function friendly(err) {
  if (err instanceof ClaudeError) return err;
  if (err instanceof Anthropic.AuthenticationError) return new ClaudeError('Chave da API inválida. Verifique em Configurações → Claude.', 'auth');
  if (err instanceof Anthropic.RateLimitError) return new ClaudeError('Limite de uso da API atingido. Tente de novo em instantes.', 'rate_limit');
  if (err instanceof Anthropic.APIConnectionError) return new ClaudeError('Sem conexão com a API do Claude.', 'offline');
  if (err instanceof Anthropic.APIUserAbortError || err?.name === 'AbortError') return new ClaudeError('Cancelado.', 'aborted');
  if (err instanceof Anthropic.APIError) return new ClaudeError(`Erro da API (${err.status}): ${err.message}`, 'api');
  return new ClaudeError(err?.message || String(err), 'unknown');
}

/**
 * Executa uma requisição em streaming.
 * - schema: JSON Schema para saída estruturada (a resposta é JSON validado)
 * - onText: recebe os trechos de texto à medida que chegam
 */
async function run({ cfg, content, messages, schema, effort = 'medium', maxTokens = 16000, onText, signal }) {
  if (cfg.provider === 'subscription') return runSubscription({ cfg, content, messages, schema, effort, onText, signal });
  const anthropic = client(cfg.apiKey);
  const params = {
    model: cfg.model || DEFAULT_MODEL,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: messages || [{ role: 'user', content }],
    output_config: { effort, ...(schema ? { format: { type: 'json_schema', schema } } : {}) },
  };
  // se o modelo principal recusar, a API repete a requisição num modelo alternativo
  // (o Haiku não tem fallback no servidor)
  if (!/haiku/.test(params.model)) Object.assign(params, { betas: [FALLBACK_BETA], fallbacks: 'default' });
  try {
    const stream = anthropic.beta.messages.stream(params, { signal });
    if (onText) stream.on('text', (t) => onText(t));
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') throw new ClaudeError('O Claude não pôde responder a este pedido.', 'refusal');
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (!schema) return { text, usage: msg.usage };
    if (msg.stop_reason === 'max_tokens') throw new ClaudeError('A resposta ficou longa demais. Tente um trecho menor.', 'max_tokens');
    return { data: JSON.parse(text), usage: msg.usage };
  } catch (err) {
    throw friendly(err);
  }
}

// Pela assinatura: o mesmo pedido, achatado em texto, vai para a CLI do Claude Code.
const blockText = (c) => (typeof c === 'string' ? c : c.map((b) => b.text).join('\n\n'));
async function runSubscription({ cfg, content, messages, schema, effort, onText, signal }) {
  let prompt;
  if (messages) {
    // conversa: a CLI recebe o histórico inteiro a cada pergunta
    const first = blockText(messages[0].content);
    const rest = messages.slice(1).map((m) => `${m.role === 'user' ? 'AUTOR' : 'VOCÊ (Claude)'}: ${blockText(m.content)}`).join('\n\n');
    prompt = messages.length === 1 ? first
      : `${first}\n\n<historico_da_conversa>\n${rest}\n</historico_da_conversa>\n\nResponda à última mensagem do AUTOR.`;
  } else prompt = blockText(content);
  try {
    return await runCLI({ system: SYSTEM, prompt, schema, model: cfg.model, effort, onText, signal, cliPath: cfg.cliPath, cwd: cfg.cwd });
  } catch (e) {
    throw e instanceof CLIError ? new ClaudeError(e.message, e.code) : friendly(e);
  }
}

/** Confere se o Claude está pronto para uso (CLI encontrada e logada, ou chave da API). */
export async function check(cfg, ctx) {
  if (cfg.provider === 'subscription') {
    const bin = findClaude(cfg.cliPath);
    if (!bin) throw new ClaudeError('Claude Code não encontrado. Instale com "npm install -g @anthropic-ai/claude-code" e rode "claude" no terminal para entrar com sua conta.', 'no_cli');
    const r = await runSubscription({ cfg: { ...cfg, model: 'haiku' }, content: 'Responda apenas: ok', effort: 'low', signal: ctx.signal });
    return { ok: true, via: bin, reply: r.text.trim().slice(0, 40) };
  }
  const r = await run({ cfg: { ...cfg, model: 'claude-haiku-5-5' }, content: 'Responda apenas: ok', effort: 'low', maxTokens: 50, signal: ctx.signal });
  return { ok: true, via: 'API', reply: r.text.trim().slice(0, 40) };
}

const scriptBlock = (text) => ({
  type: 'text',
  text: `<roteiro>\n${text}\n</roteiro>`,
  cache_control: { type: 'ephemeral' },
});

const str = { type: 'string' };
const arr = (items) => ({ type: 'array', items });
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

// ---------------------------------------------------------------------------
// Análise (em tempo real: cena atual; completa: roteiro inteiro)

const NOTE_KINDS = ['estrutura', 'personagem', 'dialogo', 'ritmo', 'continuidade', 'formatacao', 'gramatica', 'producao'];
const analysisSchema = obj({
  summary: str,
  notes: arr(obj({
    scene: str,
    quote: str,
    kind: { type: 'string', enum: NOTE_KINDS },
    severity: { type: 'string', enum: ['info', 'sugestao', 'problema'] },
    note: str,
    suggestion: str,
  })),
});

export async function analyze(cfg, { text, scope = 'scene', sceneText, sceneNumber, paper, lang }, ctx) {
  const st = stats(text, { paper, lang });
  const task = scope === 'scene'
    ? `O autor está escrevendo agora a cena ${sceneNumber || ''}. Analise apenas esta cena, no contexto do roteiro inteiro:

<cena_atual>
${sceneText}
</cena_atual>

Devolva no máximo 5 notas, só as que realmente importam (problemas de lógica, continuidade com cenas anteriores,
diálogo expositivo ou fora da voz do personagem, ritmo, formatação Fountain incorreta, erros de português).
Em "quote" copie literalmente um trecho curto (até 80 caracteres) da cena ao qual a nota se refere.
"summary" é uma frase sobre o que a cena faz pela história.`
    : `Faça uma análise completa do roteiro como consultor: estrutura (atos, pontos de virada), arcos dos personagens,
ritmo, diálogo, continuidade e viabilidade de produção. Devolva até 25 notas ordenadas pela importância.
Em "quote" copie literalmente um trecho curto (até 80 caracteres) do roteiro, e em "scene" o número da cena.
"summary" é um parágrafo de avaliação geral (logline percebida, pontos fortes, principal problema).`;
  return run({
    cfg,
    content: [scriptBlock(text), { type: 'text', text: `<cenas>\n${sceneTable(st)}\n</cenas>` }, { type: 'text', text: task }],
    schema: analysisSchema,
    effort: scope === 'scene' ? 'low' : 'high',
    maxTokens: scope === 'scene' ? 8000 : 32000,
    signal: ctx.signal,
  });
}

// ---------------------------------------------------------------------------
// Revisão gramatical e ortográfica

const grammarSchema = obj({
  corrections: arr(obj({
    original: str,
    replacement: str,
    kind: { type: 'string', enum: ['ortografia', 'gramatica', 'concordancia', 'pontuacao', 'acentuacao', 'estilo', 'formatacao'] },
    explanation: str,
  })),
});

export async function grammar(cfg, { passage }, ctx) {
  return run({
    cfg,
    content: [{ type: 'text', text: `Revise a ortografia, a gramática, a concordância, a acentuação e a pontuação do trecho de roteiro abaixo.
Não reescreva o estilo: falas podem ser coloquiais de propósito ("tá", "pra", "cê"); corrija só erros reais.
Nomes de personagem em maiúsculas, cabeçalhos de cena e sintaxe Fountain não devem ser alterados.
Para cada erro, "original" deve ser um trecho copiado literalmente (com algumas palavras ao redor, para ser único)
e "replacement" o mesmo trecho corrigido.

<trecho>
${passage}
</trecho>` }],
    schema: grammarSchema,
    effort: 'low',
    maxTokens: 8000,
    signal: ctx.signal,
  });
}

// ---------------------------------------------------------------------------
// Listas de produção (decupagem / breakdown)

const breakdownSchema = obj({
  scenes: arr(obj({
    number: str,
    cast: arr(str),
    extras: arr(str),
    props: arr(str),
    wardrobe: arr(str),
    makeup: arr(str),
    set_dressing: arr(str),
    vehicles: arr(str),
    animals: arr(str),
    sfx: arr(str),
    vfx: arr(str),
    sound: arr(str),
    stunts: arr(str),
    notes: str,
  })),
  cast: arr(obj({ name: str, description: str })),
  locations: arr(obj({ name: str, scenes: arr(str), notes: str })),
});

export async function breakdown(cfg, { text, paper, lang }, ctx) {
  const st = stats(text, { paper, lang });
  return run({
    cfg,
    content: [scriptBlock(text), { type: 'text', text: `<cenas>\n${sceneTable(st)}\n</cenas>` }, {
      type: 'text',
      text: `Faça a decupagem de produção (breakdown) de TODAS as cenas, na ordem, usando o número de cada cena da tabela.
Para cada cena liste: elenco com fala ou ação (cast), figuração (extras, com quantidade estimada), objetos de cena (props),
figurino (wardrobe), maquiagem e cabelo (makeup), cenografia/direção de arte (set_dressing), veículos, animais,
efeitos especiais práticos (sfx), efeitos visuais (vfx), som/música em cena (sound), dublês e ações de risco (stunts)
e observações de produção (notes). Inclua só o que o texto indica ou implica com clareza; listas vazias quando não houver.
Em "cast", descreva cada personagem em uma linha (idade, papel). Em "locations", agrupe as cenas por locação física.`,
    }],
    schema: breakdownSchema,
    effort: 'medium',
    maxTokens: 64000,
    onText: ctx.emit ? (t) => ctx.emit({ type: 'progress', chars: t.length }) : undefined,
    signal: ctx.signal,
  });
}

// ---------------------------------------------------------------------------
// Plano de filmagem

const scheduleSchema = obj({
  days: arr(obj({
    day: { type: 'integer' },
    date: str,
    unit: str,
    call_time: str,
    wrap_time: str,
    scenes: arr(obj({ number: str, cast: arr(str), notes: str })),
    notes: str,
  })),
  rationale: str,
  warnings: arr(str),
});

export async function schedule(cfg, { text, paper, lang, params = {} }, ctx) {
  const st = stats(text, { paper, lang });
  const p = {
    startDate: params.startDate || '',
    hoursPerDay: params.hoursPerDay || 10,
    pagesPerDay: params.pagesPerDay || 4,
    daysOff: params.daysOff || 'domingos',
    callTime: params.callTime || '07:00',
    notes: params.notes || '',
  };
  const res = await run({
    cfg,
    content: [scriptBlock(text), { type: 'text', text: `<cenas>\n${sceneTable(st)}\n</cenas>` }, {
      type: 'text',
      text: `Monte o plano de filmagem (ordem do dia por diária) para este roteiro, como um primeiro assistente de direção.
Parâmetros da produção:
- início: ${p.startDate || 'não definido (use "Diária 1", "Diária 2"… em date)'}
- jornada: ${p.hoursPerDay} horas por diária, chamada às ${p.callTime}
- meta: cerca de ${p.pagesPerDay} páginas por diária (as durações de cada cena estão na tabela, em oitavos de página)
- folgas: ${p.daysOff}
${p.notes ? `- observações do produtor: ${p.notes}` : ''}

Regras: agrupe cenas da mesma locação para evitar deslocamentos; agrupe períodos (dia/noite) e evite virar de noite para dia
sem descanso; concentre as diárias de cada ator; cenas complexas (dublês, efeitos, crianças, animais, muita figuração) contam
mais que seu tamanho em páginas; inclua TODAS as cenas exatamente uma vez. Em "unit" escreva a locação/unidade principal da
diária. Explique as escolhas em "rationale" e liste riscos em "warnings".`,
    }],
    schema: scheduleSchema,
    effort: 'high',
    maxTokens: 64000,
    onText: ctx.emit ? (t) => ctx.emit({ type: 'progress', chars: t.length }) : undefined,
    signal: ctx.signal,
  });
  // completa com os dados calculados localmente (oitavos, cabeçalhos)
  const byNum = new Map(st.scenes.map((s) => [String(s.number), s]));
  const seen = new Set();
  for (const d of res.data.days) {
    let total = 0;
    for (const s of d.scenes) {
      const info = byNum.get(String(s.number).replace(/^#/, ''));
      seen.add(String(s.number).replace(/^#/, ''));
      s.heading = info ? info.heading : '';
      s.eighths = info ? info.eighths : 0;
      s.pages = info ? info.pages : '';
      s.intExt = info ? info.intExt : '';
      s.time = info ? info.time : '';
      total += s.eighths;
    }
    d.eighths = total;
  }
  const missing = st.scenes.filter((s) => !seen.has(String(s.number))).map((s) => s.number);
  if (missing.length) res.data.warnings.push(`Cenas fora do plano: ${missing.join(', ')}`);
  return res;
}

// ---------------------------------------------------------------------------
// Edição do texto: o Claude devolve trechos a substituir, que o editor mostra
// como alterações para revisar (ou aplica direto, se o autor preferir)

const editSchema = obj({
  summary: str,
  edits: arr(obj({ original: str, replacement: str, reason: str })),
});

export async function edit(cfg, { text, scopeText, scopeLabel, instruction, history = [] }, ctx) {
  const whole = !scopeText || scopeText === text;
  const convo = history.length
    ? `\n<conversa_anterior>\n${history.map((m) => `${m.role === 'user' ? 'AUTOR' : 'VOCÊ'}: ${m.content}`).join('\n\n')}\n</conversa_anterior>\n`
    : '';
  const task = `O autor pediu uma alteração no roteiro${whole ? '' : `, limitada a: ${scopeLabel}`}.
${convo}
<pedido>
${instruction}
</pedido>
${whole ? '' : `\n<trecho_a_editar>\n${scopeText}\n</trecho_a_editar>\n`}
Faça a alteração pedida e devolva-a como uma lista de substituições ("edits"):
- "original": trecho copiado LITERALMENTE do ${whole ? 'roteiro' : 'trecho a editar'} (mesmos caracteres, espaços, quebras de linha e marcações), longo o bastante para ser único;
- "replacement": o texto novo que entra no lugar dele, em Fountain válido (cabeçalhos INT./EXT. em maiúsculas, personagem em maiúsculas numa linha seguido da fala, linha em branco entre blocos);
- para INSERIR texto novo, use como "original" a linha logo antes do ponto de inserção e repita-a no começo de "replacement";
- para APAGAR, use "replacement" vazio;
- prefira várias substituições pequenas e precisas a reescrever trechos grandes que não mudam; liste-as na ordem em que aparecem no texto, sem sobreposição;
- "reason": uma frase curta explicando a mudança.
Mude só o que o pedido exige e preserve a voz do autor. "summary" diz em uma ou duas frases o que foi feito.
Se o pedido for só uma pergunta e não pedir mudança, responda em "summary" e devolva "edits" vazio.`;
  return run({
    cfg,
    content: [scriptBlock(text), { type: 'text', text: task }],
    schema: editSchema,
    effort: whole ? 'high' : 'medium',
    maxTokens: 64000,
    onText: ctx.emit ? (t) => ctx.emit({ type: 'progress', chars: t.length }) : undefined,
    signal: ctx.signal,
  });
}

// ---------------------------------------------------------------------------
// Conversa livre sobre o roteiro (streaming)

export async function chat(cfg, { text, history }, ctx) {
  const messages = history.map((m, i) => ({
    role: m.role,
    content: i === 0 && m.role === 'user' ? [scriptBlock(text), { type: 'text', text: m.content }] : m.content,
  }));
  return run({ cfg, messages, effort: 'medium', maxTokens: 32000, onText: (t) => ctx.emit({ type: 'text', text: t }), signal: ctx.signal });
}
