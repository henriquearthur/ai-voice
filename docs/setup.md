# Configurar AI Voice

Requer Node.js 22 ou superior, npm, conta Amazon dos Echos e acesso ao navegador neste Mac. O Mac precisa estar ligado e com internet enquanto o MCP estiver em uso. A conexão com a Alexa depende de interfaces comunitárias; [limitações e pesquisa](alexa-feasibility.md).

## Instalar e autenticar sem áudio

No diretório do projeto:

```sh
npm ci
npm test
npm run login
```

Quando o terminal indicar que o proxy está pronto, abra **http://127.0.0.1:3456/** neste Mac e faça login Amazon, incluindo MFA/CAPTCHA se solicitado. A senha e o MFA são preenchidos no navegador; não os envie ao agente. O proxy é local, encaminha o login para Amazon e fecha ao concluir, após dez minutos ou com Ctrl+C. O login pode registrar um dispositivo virtual na conta Amazon.

Sessão e tokens ficam em `~/.local/share/ai-voice/`, com diretório `0700` e sessão `0600`. Não compartilhe essa pasta nem ative debug das bibliotecas. O login é separado do MCP: ele nunca abre um proxy automaticamente.

Depois, verifique o inventário:

```sh
npm run devices
```

Esse comando não reproduz áudio. Anote o `serial` do Echo que será o padrão.

## Conectar ao Claude ou Codex

Descubra o caminho absoluto do Node com `node -p process.execPath` e do projeto com `pwd`. Nos exemplos abaixo, substitua `/CAMINHO/NODE`, `/CAMINHO/ai-voice` e `SERIAL` pelos valores reais. Use o executável Node diretamente para manter stdout exclusivo do protocolo MCP.

`AI_VOICE_ENABLE_SPEECH=1` libera a fala enquanto o servidor estiver ativo; sem essa variável, `speak` é recusado e só `list_devices` funciona. `AI_VOICE_DEFAULT_DEVICE` define o Echo usado quando `speak` é chamado sem `device_serial`.

No Claude Code, cadastre para todos os projetos:

```sh
claude mcp add ai-voice --scope user \
  --env AI_VOICE_ENABLE_SPEECH=1 --env AI_VOICE_DEFAULT_DEVICE=SERIAL \
  -- /CAMINHO/NODE /CAMINHO/ai-voice/src/server.js
```

No Codex:

```sh
codex mcp add ai-voice \
  --env AI_VOICE_ENABLE_SPEECH=1 --env AI_VOICE_DEFAULT_DEVICE=SERIAL \
  -- /CAMINHO/NODE /CAMINHO/ai-voice/src/server.js
```

No Claude Desktop, acrescente o servidor ao objeto `mcpServers` de `~/Library/Application Support/Claude/claude_desktop_config.json` e reinicie o aplicativo:

```json
{
  "mcpServers": {
    "ai-voice": {
      "command": "/CAMINHO/NODE",
      "args": ["/CAMINHO/ai-voice/src/server.js"],
      "env": { "AI_VOICE_ENABLE_SPEECH": "1", "AI_VOICE_DEFAULT_DEVICE": "SERIAL" }
    }
  }
}
```

Reinicie ou reconecte o cliente após configurar. Referências: [Claude Code](https://code.claude.com/docs/en/mcp), [Claude Desktop](https://modelcontextprotocol.io/docs/develop/connect-local-servers), [Codex](https://developers.openai.com/codex/mcp/).

## Servir pela rede

Para uma máquina hospedar o AI Voice e outras o usarem, defina `AI_VOICE_HTTP_PORT`: o servidor passa a atender MCP por HTTP em `/mcp`, no lugar de stdio. A sessão Amazon fica só na máquina que hospeda.

O endpoint não tem autenticação: quem alcança a porta pode listar os Echos e falar neles. Use `AI_VOICE_HTTP_HOST` com um endereço de rede privada, como o IP Tailscale da máquina; o padrão é `127.0.0.1`. Requisições com cabeçalho `Origin` (navegadores) são recusadas.

Exemplo de serviço systemd de usuário, em `~/.config/systemd/user/ai-voice.service`:

```ini
[Unit]
Description=AI Voice MCP
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/CAMINHO/ai-voice
Environment=AI_VOICE_HTTP_HOST=IP-TAILSCALE
Environment=AI_VOICE_HTTP_PORT=7347
Environment=AI_VOICE_ENABLE_SPEECH=1
Environment=AI_VOICE_DEFAULT_DEVICE=SERIAL
ExecStart=/CAMINHO/NODE src/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Ative com `systemctl --user enable --now ai-voice` e cadastre em cada cliente:

```sh
claude mcp add ai-voice --scope user --transport http http://HOST:7347/mcp
```

## Usar

Peça ao cliente uma resposta falada; ele chama `speak` com o texto. Não há envio de fala na inicialização, no login ou na listagem.

`speak` aceita texto simples de 1 a 4000 unidades UTF-16 e rejeita vazio, SSML e grupos de dispositivos. Textos acima de 250 unidades são divididos em frases ou palavras completas e enviados como uma única sequência ordenada. Um servidor aceita uma fala por vez.

O retorno `status: "accepted"` com `playback_confirmed: false` indica que a API aceitou o pedido: só o usuário pode confirmar que ouviu. Se ocorrer timeout ou erro, não repetir automaticamente; o Echo pode ter recebido o primeiro pedido.

A sessão é renovada sem novo login: o servidor renova os tokens quando têm mais de 24 horas e confere a autenticação a cada 30 minutos de uso. Se a renovação falhar, a ferramenta pede `npm run login`.

## Configuração e diagnóstico

| Variável | Padrão | Uso |
| --- | --- | --- |
| `AI_VOICE_ENABLE_SPEECH` | bloqueado | Só o valor `1` habilita fala |
| `AI_VOICE_DEFAULT_DEVICE` | nenhum | Serial do Echo usado quando `speak` não recebe `device_serial` |
| `AI_VOICE_HTTP_PORT` | stdio | Porta para servir MCP por HTTP em `/mcp` |
| `AI_VOICE_HTTP_HOST` | `127.0.0.1` | Endereço de escuta do modo HTTP |
| `AI_VOICE_STATE_DIR` | `~/.local/share/ai-voice` | Diretório de sessão; use o mesmo no login e nos clientes |
| `AI_VOICE_AMAZON_PAGE` | `amazon.com.br` | Marketplace inicial do login; a sessão conserva a região retornada |
| `AI_VOICE_ALEXA_HOST` | derivado do marketplace | Host inicial opcional da API, sem `https://`; descoberta Amazon pode atualizá-lo |

Login, listagem e fala foram confirmados em uma conta `amazon.com.br`. Se o login/listagem falhar em outra conta, confira marketplace, MFA e a [pesquisa de região](alexa-feasibility.md#brasil-host-e-idioma) antes de mudar o host. Não apagar sessão válida ou repetir registros na conta sem necessidade. Porta 3456 ocupada: encerre o processo de login anterior ou resolva o conflito antes de tentar novamente.

`npm audit` ainda sinaliza cinco pacotes de severidade alta pela mesma cadeia transitiva de `braces`, sem versão corrigida publicada na data da pesquisa. O proxy fica restrito ao Mac e existe só durante login; o alerta permanece documentado em [Dependências](alexa-feasibility.md#dependências).
