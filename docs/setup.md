# Preparar AI Voice para um teste autorizado

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

Esse comando não reproduz áudio. Anote o `serial` de um Echo online. O primeiro teste deve usar só esse aparelho e uma frase escolhida pelo usuário.

## Conectar ao Claude ou Codex com fala bloqueada

Descubra o caminho absoluto do Node com `node -p process.execPath` e do projeto com `pwd`. Nos exemplos abaixo, substitua `/CAMINHO/NODE` e `/CAMINHO/ai-voice` pelos caminhos reais. Use o executável Node diretamente para manter stdout exclusivo do protocolo MCP.

No Claude Desktop, acrescente o servidor ao objeto `mcpServers` da configuração existente e reinicie o aplicativo:

```json
{
  "mcpServers": {
    "ai-voice": {
      "command": "/CAMINHO/NODE",
      "args": ["/CAMINHO/ai-voice/src/server.js"],
      "env": { "AI_VOICE_ENABLE_SPEECH": "0" }
    }
  }
}
```

No Claude Code, a mesma entrada pode ser usada no arquivo `.mcp.json` do projeto. [Configuração Claude Desktop no guia MCP](https://modelcontextprotocol.io/docs/develop/connect-local-servers), [configuração Claude Code](https://code.claude.com/docs/en/mcp).

No Codex, o comando abaixo cadastra o servidor com a fala bloqueada:

```sh
codex mcp add ai-voice --env AI_VOICE_ENABLE_SPEECH=0 -- /CAMINHO/NODE /CAMINHO/ai-voice/src/server.js
```

Alternativamente, acrescente a `~/.codex/config.toml`:

```toml
[mcp_servers.ai-voice]
command = "/CAMINHO/NODE"
args = ["/CAMINHO/ai-voice/src/server.js"]

[mcp_servers.ai-voice.env]
AI_VOICE_ENABLE_SPEECH = "0"
```

Reinicie/reconecte o cliente após configurar. Os exemplos seguem a [documentação oficial OpenAI de MCP](https://developers.openai.com/codex/mcp/) e o comando local `codex mcp add --help`. Nenhuma configuração global dos clientes foi alterada nesta entrega.

## Executar o teste somente depois de autorizado

Antes de enviar áudio, confirme com o usuário o Echo e a frase. Mude **apenas após essa autorização** `AI_VOICE_ENABLE_SPEECH` para `"1"` na configuração do cliente e reinicie o servidor. Essa variável libera futuras chamadas de fala enquanto o processo estiver ativo; ela não é uma autorização de uso único. Após o teste, volte para `"0"` e reinicie se quiser manter o bloqueio.

Peça ao cliente para chamar `list_devices` e, em seguida, `speak` com o `device_serial` exato e a frase autorizada em `text`. Não há envio de fala na inicialização, no login ou na listagem.

`speak` aceita texto simples de 1 a 250 unidades UTF-16, rejeita vazio/SSML e grupos de dispositivos. Retorna `status: "accepted"` quando a API aceita o pedido e `playback_confirmed: false`: só o usuário pode confirmar que ouviu. Se ocorrer timeout ou erro, não repetir automaticamente; o Echo pode ter recebido o primeiro pedido.

## Configuração e diagnóstico

| Variável | Padrão | Uso |
| --- | --- | --- |
| `AI_VOICE_ENABLE_SPEECH` | bloqueado | Só o valor `1` habilita fala |
| `AI_VOICE_STATE_DIR` | `~/.local/share/ai-voice` | Diretório de sessão; use o mesmo no login e nos clientes |
| `AI_VOICE_AMAZON_PAGE` | `amazon.com.br` | Marketplace inicial do login; a sessão conserva a região retornada |
| `AI_VOICE_ALEXA_HOST` | derivado do marketplace | Host inicial opcional da API, sem `https://`; descoberta Amazon pode atualizá-lo |

O host correto da conta brasileira ainda não foi confirmado. Se o login/listagem falhar, confira marketplace, MFA e a [pesquisa de região](alexa-feasibility.md#brasil-host-e-idioma) antes de mudar o host. Não apagar sessão válida ou repetir registros na conta sem necessidade. Porta 3456 ocupada: encerre o processo de login anterior ou resolva o conflito antes de tentar novamente.

`npm audit` ainda sinaliza cinco pacotes de severidade alta pela mesma cadeia transitiva de `braces`, sem versão corrigida publicada na data da pesquisa. O proxy fica restrito ao Mac e existe só durante login; o alerta permanece documentado em [Dependências](alexa-feasibility.md#dependências).
