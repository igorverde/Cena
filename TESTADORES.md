# Testando o Cena

Obrigado por testar! O Cena é um editor de roteiro minimalista, com o Claude integrado.

## Instalar no Mac

1. Baixe o `.dmg` certo para o seu Mac: **apple-silicon** para Macs com chip M1, M2, M3 ou M4; **intel** para os anteriores (menu  → Sobre Este Mac mostra qual é o seu).
2. Abra o `.dmg` e arraste o **Cena** para a pasta **Aplicativos**.
3. **Na primeira vez**, o macOS avisa que "não pôde verificar se o Cena está livre de malware". É o aviso padrão para apps sem a assinatura paga de desenvolvedor da Apple. Para liberar, uma única vez:
   - clique em **OK** (não em "Mover para o Lixo");
   - abra **Ajustes do Sistema → Privacidade e Segurança**, role até o fim e clique em **Abrir Mesmo Assim** ao lado de "O Cena foi bloqueado";
   - confirme com a senha do Mac.

   Ou, no Terminal, rode o comando abaixo e abra o Cena normalmente:
   ```bash
   xattr -dr com.apple.quarantine /Applications/Cena.app
   ```
   O mesmo comando resolve se aparecer "o Cena está danificado e não pode ser aberto".

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
