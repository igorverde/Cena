# Cena

Editor de roteiro para cinema, minimalista, feito para Linux.

- **Só a página, como vai ser impressa.** Sem barras nem menus. O editor mostra o roteiro já formatado: página de rosto centralizada, negrito, itálico e sublinhado sem asteriscos, números de cena nas margens e as quebras de página numeradas exatamente como no PDF. As marcações aparecem (esmaecidas) só na linha em que o cursor está. Todos os comandos ficam em `Ctrl+K`.
- **Formato aberto.** Os roteiros são arquivos [Fountain](https://fountain.io) (`.fountain`), texto puro. Abrem em qualquer editor, no Beat, Highland, Slugline e afins, e funcionam bem com git.
- **Exporta** PDF no padrão da indústria (página de rosto, cenas numeradas, `(MAIS)`/`(CONT.)`, diálogo duplo, A4 ou Carta), **Final Draft (.fdx)** e Fountain. Também **importa .fdx**.
- **Salva sozinho**: no disco a cada pausa na digitação, com histórico de versões, e **na nuvem** por WebDAV (Nextcloud, ownCloud, Box, Koofr…) ou por uma pasta sincronizada (Dropbox, Google Drive, OneDrive, Syncthing, MEGA). Se dois dispositivos editam ao mesmo tempo, nenhum texto se perde.
- **Correção**:
  - ortografia com dicionário pt-BR (VERO/LibreOffice) ou en-US e dicionário pessoal;
  - correção automática ao digitar (`voce → você`, `nao → não`, maiúscula no início da frase);
  - formatação automática dos elementos (cabeçalhos, nomes, extensões `(V.O.)`/`(O.S.)`, transições) e o comando *Corrigir formatação do roteiro*;
  - gramática com o Claude (`Ctrl+Shift+G`) e, se você quiser, verificação contínua com o LanguageTool.
- **Claude integrado, pela sua assinatura** (Pro/Max, via Claude Code — sem chave de API nem cobrança extra) ou por chave da API:
  - **notas em tempo real** sobre a cena em que você está (estrutura, diálogo, ritmo, continuidade, português, formatação), alguns segundos depois que você para de digitar;
  - **análise completa** do roteiro;
  - **listas de produção**: cenas, personagens e locações (calculadas na hora, sem IA) e a **decupagem** por cena feita pelo Claude (elenco, figuração, objetos, figurino, maquiagem, arte, veículos, animais, efeitos, som, dublês), exportável em CSV e PDF;
  - **plano de filmagem**: diárias agrupadas por locação, período e elenco, com oitavos de página calculados pela paginação real, exportável em CSV e PDF;
  - **conversa** sobre o roteiro;
  - **edição do texto pelo Claude**: selecione um trecho (ou fique numa cena) e peça a mudança com `Ctrl+Shift+E`, ou marque *Editar o texto* na conversa. As alterações aparecem no próprio texto, com o trecho removido riscado e o novo em verde. Aceite ou rejeite uma a uma (✓/✗) ou todas de uma vez. Se preferir, ative *Aplicar as edições direto* nas configurações; `Ctrl+Z` sempre desfaz.

## Instalar e rodar

Precisa do Node.js 20 ou mais novo.

```bash
git clone <este repositório> cena && cd cena
```

```bash
npm install
```

```bash
npm start
```

### Gerar o instalador (AppImage e .deb)

```bash
npm run dist
```

Os pacotes ficam em `release/` (o AppImage roda em qualquer distribuição; o `.deb` registra o Cena como programa para arquivos `.fountain`).

### Sem Electron: modo navegador

```bash
npm run web
```

Abra o endereço que aparece no terminal (o link já inclui uma chave de acesso; o servidor só escuta em `127.0.0.1`).

## Configurar

`Ctrl+,` abre as configurações.

- **Claude pela assinatura** (padrão): instale o Claude Code e entre com sua conta uma vez:

  ```bash
  npm install -g @anthropic-ai/claude-code
  ```

  ```bash
  claude
  ```

  Dentro dele, use `/login` se pedir e depois saia com `/exit`. No Cena, `Ctrl+,` → Claude → **Testar o Claude**. O uso conta nos limites do seu plano. A análise em tempo real faz uma chamada a cada pausa em que a cena mudou; desligue em *Tempo real* se quiser poupar o limite.
- **Claude pela API** (alternativa): escolha *Chave da API* e cole a chave (crie em console.anthropic.com). Cobrança por uso, separada da assinatura. No app desktop a chave fica criptografada pelo chaveiro do sistema.
- **Nuvem / Nextcloud**: endereço WebDAV da pasta, por exemplo `https://nuvem.exemplo.com/remote.php/dav/files/SEU_USUARIO/Roteiros/`, seu usuário e uma *senha de aplicativo*. Use *Testar conexão*.
- **Nuvem / pasta sincronizada**: escolha a pasta do Dropbox, Google Drive (Insync, `rclone mount`) etc. O Cena grava uma cópia a cada alteração e o cliente da nuvem envia.
- **LanguageTool** (opcional): o servidor público recebe o texto. Para manter tudo local, rode `docker run -p 8081:8010 erikvl87/languagetool` e use `http://localhost:8081/v2/check`.

## Escrevendo

| Tecla | Faz |
|---|---|
| `Tab` / `Shift+Tab` | alterna o elemento: ação → personagem → cena → transição |
| `Tab` numa linha vazia depois da fala | abre um parentético `( )` |
| `Enter` | segue o fluxo: personagem → fala → ação; cena → ação; transição → cena |
| `Shift+Enter` | quebra de linha simples |
| `Ctrl+B` / `Ctrl+I` / `Ctrl+U` | negrito / itálico / sublinhado |
| `Ctrl+Shift+E` | pedir ao Claude para editar a seleção ou a cena |
| `Ctrl+K` | todos os comandos |
| `Ctrl+G` | ir para cena |
| `Ctrl+J` | painel do Claude |
| `Ctrl+Shift+L` | conversar com o Claude |
| `Ctrl+Shift+G` | revisar o português da cena com o Claude |
| `Ctrl+Shift+I` | corrigir formatação |
| `Ctrl+E` | exportar PDF |
| `Ctrl+F` | buscar e substituir |
| `F11` / `Ctrl+Shift+F11` | tela cheia / modo foco |
| `F1` | ajuda |

O autocompletar sugere personagens, extensões, locações já usadas, períodos (DIA, NOITE, CONTÍNUO…) e transições.

### Fountain em 30 segundos

```
Title: A Última Sessão
Author: Fulana de Tal

INT. CABINE DE PROJEÇÃO - NOITE

Poeira dançando no feixe de luz.

MARTA
(baixinho)
Mais uma noite, meu velho.

LUCAS ^
Fantasmas pagam meia?

CORTA PARA:
```

`.TEXTO` força um cabeçalho, `@Nome` força um personagem, `> TEXTO` uma transição, `> TEXTO <` centraliza, `NOME ^` cria diálogo duplo, `[[nota]]` e `/* trecho */` não são impressos, `# Ato` e `= sinopse` organizam a estrutura, `===` quebra a página.

## Onde ficam os arquivos

| O quê | Onde |
|---|---|
| Roteiros novos | `~/Documentos/Roteiros/` (pasta de documentos do XDG) |
| Configurações | `~/.config/cena/settings.json` (permissão 600) |
| Histórico de versões | `~/.local/share/cena/historico/` (últimas 100 por roteiro) |
| Listas e plano gerados | `~/.local/share/cena/producao/` |

## Desenvolvimento

```bash
npm test
```

```
src/core/      parser Fountain, paginação, PDF, FDX, formatação, ortografia, estatísticas (sem dependência de interface)
src/server/    backend: arquivos, nuvem, Claude, LanguageTool; web.js serve o modo navegador
src/main/      processo principal do Electron e preload
src/renderer/  interface: editor (CodeMirror 6), painel do Claude, paleta de comandos
test/          testes (node --test), inclusive com servidores WebDAV e Claude simulados
```

O corretor ortográfico lê dicionários Hunspell diretamente (`src/core/spell.js`), removendo afixos na consulta, porque expandir o dicionário pt-BR geraria mais de 10 milhões de formas.

Licenças: código GPL v3 (veja LICENSE). Dicionário pt-BR VERO (LGPL/MPL), en-US (MIT/BSD), fonte Courier Prime (OFL).
