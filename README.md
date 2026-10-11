# AI Voice

Prova mínima de um MCP local para Claude e Codex enviarem texto a um Amazon Echo, usando a voz da Alexa em português. Expõe `list_devices` e `speak`, um Echo por chamada, sem alterar volume.

**Fala bloqueada por padrão. Nenhum teste audível foi executado.** O protocolo MCP foi verificado localmente; login Amazon, região da conta e reprodução física ainda precisam de validação.

- Para instalar, autenticar e preparar o teste: [Preparar AI Voice](docs/setup.md).
- Para entender o caminho escolhido e seus limites: [Viabilidade da integração Alexa](docs/alexa-feasibility.md).

Verificação local: `npm ci && npm test`. Os testes usam dispositivos e transporte Amazon simulados; o teste MCP usa stdio real.
