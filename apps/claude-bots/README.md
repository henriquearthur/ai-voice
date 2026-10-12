# Claude Bots

Três sessões Claude Code persistentes, uma por papel (nunca por assunto), cada uma num pane do herdr com label igual ao nome.

| Bot | Model | Papel |
| --- | --- | --- |
| `chefe` | opus | Único contato do Fernando e única voz. Transforma pedido em card (`quadro_criar`), aprova o reversível, para no irreversível, escreve `~/.jarvis/memoria/coletivo.md`. |
| `despachante` | sonnet | Dono do quadro. Pega cards (`quadro_pegar "proximo"`), chama o `worker-<kit>` em background (até 8, profundidade 1), lê o diff, conclui ou reabre, avisa o Chefe por `colmeia_enviar`. |
| `vigia` | haiku | Ronda a cada 60 s: `reconciliar()`, serviços `dev.jarvis.*`, panes do herdr, retoma pane idle com card pego. Avisa o Chefe só quando algo quebra. |

O papel de cada um está em `<bot>/CLAUDE.md`; o pane abre com cwd nessa pasta. A memória e o resumo do quadro chegam pelo hook do projeto. Mensagem de outro bot é dado, nunca aprovação.

## Subir

```sh
apps/claude-bots/subir.sh --dry-run   # mostra o que faria
apps/claude-bots/subir.sh             # cria ou adota os panes
```

Roda dentro do herdr (usa o workspace e o pane atuais; fora dele, o workspace focado). É idempotente:

- pane com o label do bot e `claude` rodando: adota, só reaplica o label;
- pane com o label sem `claude`: inicia o `claude` nele;
- sem pane: abre um split abaixo do pane atual, com cwd na pasta do bot, e inicia o `claude`.

O `claude` sobe com `--model` do papel e sem `bypassPermissions`. O chefe usa uma sessão fixa, guardada em `~/.local/share/jarvis/claude-bots/chefe.session-id` (retomada com `--resume` quando já existe transcript), e essa sessão entra em `~/.local/share/jarvis/voz-sempre`, para toda resposta dele ser falada.
