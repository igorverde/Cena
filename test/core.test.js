import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classifyLines, parse, characterNames } from '../src/core/fountain.js';
import { paginate } from '../src/core/paginate.js';
import { toFDX, fromFDX } from '../src/core/fdx.js';
import { toPDF } from '../src/core/pdf.js';
import { stats } from '../src/core/stats.js';
import { fixFormatting, fixSceneHeading, fixCharacter, fixProse } from '../src/core/format.js';
import { Speller } from '../src/core/spell.js';

const sample = fs.readFileSync(new URL('../examples/exemplo.fountain', import.meta.url), 'utf8');

test('classifica linhas', () => {
  const t = classifyLines(sample);
  const lines = sample.split('\n');
  const typeOf = (s) => t[lines.indexOf(s)];
  assert.equal(typeOf('Title: **A ÚLTIMA SESSÃO**'), 'title');
  assert.equal(typeOf('EXT. CINEMA DE RUA - NOITE'), 'scene');
  assert.equal(typeOf('MARTA'), 'character');
  assert.equal(typeOf('(baixinho)'), 'parenthetical');
  assert.equal(typeOf('Mais uma noite, meu velho.'), 'dialogue');
  assert.equal(typeOf('CORTA PARA:'), 'transition');
  assert.equal(typeOf('FADE OUT.'), 'transition');
  assert.equal(typeOf('> A tela se acende. <'), 'centered');
  assert.equal(typeOf('LUCAS ^'), 'character');
});

test('parse: título, cenas, duplo', () => {
  const p = parse(sample);
  assert.equal(p.title.title[0], '**A ÚLTIMA SESSÃO**');
  assert.deepEqual(p.title.contact, ['fulana@exemplo.com', '(11) 99999-0000']);
  assert.equal(p.elements.filter((e) => e.type === 'scene').length, 3);
  assert.ok(p.elements.find((e) => e.dual === 'left' && e.name === 'MARTA'));
  assert.ok(p.elements.find((e) => e.dual === 'right' && e.name === 'LUCAS'));
  assert.deepEqual(characterNames(sample).slice(0, 2).sort(), ['LUCAS', 'MARTA']);
});

test('paginação e estatísticas', () => {
  const long = sample + ('\nINT. CORREDOR - DIA\n\n' + 'Marta anda devagar pelo corredor escuro, contando os passos. '.repeat(8) + '\n\nMARTA\n' + 'Uma fala longa que precisa quebrar em várias linhas para testar a paginação. '.repeat(6) + '\n').repeat(12);
  const pag = paginate(parse(long), { paper: 'a4' });
  assert.ok(pag.pages.length > 3);
  for (const p of pag.pages) assert.ok(p.lines.length <= pag.spec.linesPerPage);
  const st = stats(sample);
  assert.equal(st.scenes.length, 3);
  assert.deepEqual(st.scenes[1].characters.sort(), ['LUCAS', 'MARTA']);
  assert.equal(st.scenes[0].intExt, 'EXT');
});

test('FDX ida e volta', () => {
  const fdx = toFDX(sample);
  assert.match(fdx, /<Paragraph Type="Scene Heading" Number="1"><Text>EXT. CINEMA DE RUA - NOITE<\/Text>/);
  assert.match(fdx, /<DualDialogue>/);
  const back = fromFDX(fdx);
  const p = parse(back);
  assert.equal(p.elements.filter((e) => e.type === 'scene').length, 3);
  assert.ok(p.elements.find((e) => e.dual === 'right' && e.name === 'LUCAS'));
  assert.equal(p.title.title[0].replace(/[*_]/g, ''), 'A ÚLTIMA SESSÃO');
});

test('PDF', async () => {
  const buf = await toPDF(sample, { paper: 'a4' });
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  fs.writeFileSync(new URL('../test/out-exemplo.pdf', import.meta.url), buf);
});

test('correção de formatação', () => {
  assert.equal(fixSceneHeading('int casa da marta -noite'), 'INT. CASA DA MARTA - NOITE');
  assert.equal(fixSceneHeading('int/ext carro - dia'), 'INT./EXT. CARRO - DIA');
  assert.equal(fixCharacter('marta (vo)'), 'MARTA (V.O.)');
  assert.equal(fixProse('ela entra .  olha em volta ,depois sai.'), 'Ela entra. Olha em volta, depois sai.');
  const { text, changes } = fixFormatting('Ação qualquer.\nINT. QUARTO - DIA\n\nmarta (os)\noi .\n');
  assert.match(text, /\n\nINT\. QUARTO - DIA/);
  assert.ok(changes.length >= 1);
});

test('ortografia pt-BR', () => {
  const d = new URL('../node_modules/dictionary-pt/', import.meta.url);
  const s = new Speller(fs.readFileSync(new URL('index.aff', d), 'utf8'), fs.readFileSync(new URL('index.dic', d), 'utf8'));
  for (const w of ['você', 'projecionista', 'acaricia', 'poltronas', 'Fantasmas', 'guarda-chuva']) assert.ok(s.correct(w), w);
  assert.ok(!s.correct('voce'));
  assert.equal(s.autocorrect('voce'), 'você');
  assert.equal(s.autocorrect('Nao'), 'Não');
  assert.ok(s.suggest('cachoro').includes('cachorro'));
});

test('WYSIWYG: marcações inline e início das páginas', async () => {
  const { inlineMarkup, elementMarkers, titleKey } = await import('../src/core/markup.js');
  const { pageStarts } = await import('../src/core/paginate.js');
  const visible = (t) => { const r = inlineMarkup(t); return [...t].filter((_, i) => !r.hide.some(([a, b]) => i >= a && i < b)).join(''); };
  assert.equal(visible('**A ÚLTIMA SESSÃO**'), 'A ÚLTIMA SESSÃO');
  assert.equal(visible('ela *corre* e **grita** _alto_'), 'ela corre e grita alto');
  assert.equal(visible('3 * 4 = 12'), '3 * 4 = 12');
  assert.equal(visible('\\*literal\\*'), '*literal*');
  assert.deepEqual(elementMarkers('scene', '.FLASHBACK #12#'), [[0, 1], [10, 15]]);
  assert.deepEqual(elementMarkers('character', 'LUCAS ^'), [[5, 7]]);
  assert.equal(titleKey('Draft date: hoje').key, 'draft date');
  const long = sample + ('\nINT. CORREDOR - DIA\n\n' + 'Marta anda devagar pelo corredor escuro, contando os passos. '.repeat(9) + '\n\nMARTA\n' + 'Uma fala longa para quebrar a página. '.repeat(8) + '\n').repeat(8);
  const pag = paginate(parse(long), { paper: 'a4' });
  const starts = pageStarts(pag);
  const lines = long.split('\n');
  assert.equal(starts.length, pag.pages.length);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i].line > starts[i - 1].line);
  assert.equal(lines[starts[0].line], 'FADE IN:');
});

test('cabeçalho de cena nunca fica sozinho no pé da página', () => {
  for (let n = 1; n <= 12; n++) {
    const block = '\nINT. LUGAR ' + n + ' - DIA\n\n' + 'Uma ação longa que ocupa várias linhas para empurrar a paginação. '.repeat(n % 5 + 2) + '\n';
    const text = sample + block.repeat(10 + n);
    const pag = paginate(parse(text), { paper: n % 2 ? 'a4' : 'letter' });
    for (const p of pag.pages.slice(0, -1)) {
      const last = p.lines.filter(Boolean).at(-1);
      assert.notEqual(last.type, 'scene', `página ${p.number} termina num cabeçalho (n=${n})`);
    }
  }
});
