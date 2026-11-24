# Testando o Cena

Obrigado por testar! O Cena é um editor de roteiro minimalista, com o Claude integrado.

## Instalar no Mac

1. Baixe o `.dmg` certo para o seu Mac: **apple-silicon** para Macs com chip M1, M2, M3 ou M4; **intel** para os anteriores (menu  → Sobre Este Mac mostra qual é o seu).
2. Abra o `.dmg` e arraste o **Cena** para a pasta **Aplicativos**.
3. **Na primeira vez**, abra com **clique direito no Cena → Abrir → Abrir**. O app ainda não tem assinatura de desenvolvedor da Apple, por isso o macOS pergunta uma vez.
   Se aparecer "o Cena está danificado", abra o Terminal e rode:
   ```bash
   xattr -cr /Applications/Cena.app
   ```

## Usar o Claude

Na primeira vez, o Cena procura o Claude Code no seu computador para usar a **sua assinatura** do Claude (Pro ou Max):

```bash
npm install -g @anthropic-ai/claude-code
```
```bash
claude
```

Entre com sua conta (`/login`), saia com `/exit` e, no Cena, abra **Cmd+,** → Claude → **Testar o Claude**. Quem tiver uma chave da API pode escolher *Chave da API* em vez disso.

## Atalhos

No Mac, onde a ajuda diz **Ctrl**, use **Cmd**. Os principais: **Cmd+K** (todos os comandos), **Tab** (alterna personagem/cena/transição), **Cmd+J** (painel do Claude), **Cmd+Shift+E** (pedir ao Claude para editar o trecho), **Cmd+E** (exportar PDF), **F1** (ajuda).

## O que nos interessa saber

- O que travou, sumiu ou fez algo inesperado (e o que você estava fazendo na hora);
- Se o PDF e o FDX saíram como você esperava (compare com o Final Draft, se tiver);
- O que faltou para você trocar seu editor atual pelo Cena;
- Se as notas, listas, plano de filmagem e edições do Claude ajudaram ou atrapalharam.

Seus roteiros ficam em **Documentos/Roteiros** como arquivos `.fountain` (texto puro), que você pode abrir em qualquer outro programa.
