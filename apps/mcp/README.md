# @jarvis/mcp

Servidor MCP do Jarvis (`jarvis-voice`, stdio) e receptor de callbacks (`jarvis-callback`). A lista completa das tools de voz e Apple está em `docs/configuration.md`; este arquivo documenta as tools do herdr.

## Tools do herdr (somente stdio)

Controlam qualquer agente vivo do [herdr](https://herdr.dev) por argv (`spawn` sem shell). O alvo `agent` é o nome do agente ou o pane id, sempre validado contra `herdr agent list`; nome desconhecido devolve erro com a lista dos agentes vivos.

| Tool | Parâmetros | O que faz |
| --- | --- | --- |
| `herdr_agents` | nenhum | Lista `name`, `pane`, `kind`, `state` e `blocked` (true quando o agente espera uma permissão ou pergunta). |
| `herdr_read` | `agent`, `lines?` (1 a 1000, padrão 60) | Lê a cauda do terminal (`herdr agent read --source recent-unwrapped`). |
| `herdr_send` | `agent`, `text`, `steer?` (padrão true) | Digita o texto (`herdr pane send-text`) e envia `ctrl+enter`; com `steer=false`, envia `enter`. |
| `herdr_key` | `agent`, `key` | Tecla da lista branca: `approve` = enter, `deny` = esc, `cycle_mode` = shift+tab, `interrupt` = ctrl+c. |

### Guarda de autoaprovação

`approve` e `cycle_mode` são recusados quando o alvo é o próprio pane de quem chama (`HERDR_PANE_ID`, injetado pelo herdr no pane do agente que sobe o MCP). Nenhum agente aprova a própria permissão; aprovar outro agente é permitido. `deny` e `interrupt` na própria sessão continuam valendo.

### Log e métrica

Toda ação vira uma linha de log (stderr) com `acao`, `agente` e `origem=mcp`, e incrementa `jarvis_controle_acoes_total{acao,agente,origem="mcp"}` via OTLP. `acao` é `read`, `send`, `steer`, `approve`, `deny`, `cycle_mode` ou `interrupt`. O texto enviado e o conteúdo lido nunca são registrados.

### Variáveis

- `HERDR_BIN_PATH`: binário do herdr (o herdr já injeta; padrão `herdr` no PATH).
- `HERDR_PANE_ID`: pane do chamador, usado pela guarda.

## Desenvolvimento

```sh
bun run check   # tsc
bun run test    # vitest; o herdr é simulado, nenhuma tecla vai a agente real
```
