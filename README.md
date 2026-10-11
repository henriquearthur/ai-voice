# AI Voice

MCP local para Claude e Codex falarem com o usuário por um Amazon Echo, na voz da Alexa em português.

Expõe duas ferramentas:

- `list_devices`: lista os Echos físicos da conta, sem áudio.
- `speak`: fala um texto simples de até 4000 caracteres em um Echo. Usa o Echo padrão quando `device_serial` é omitido e divide textos longos em trechos ordenados.

Roda por stdio no próprio cliente ou como serviço HTTP em outra máquina da rede privada.

A fala fica bloqueada até `AI_VOICE_ENABLE_SPEECH=1` ser configurado no cliente. Volume, grupos de dispositivos e SSML ficam fora do escopo.

- Para instalar, autenticar e conectar aos clientes: [Configurar AI Voice](docs/setup.md).
- Para entender o caminho escolhido e seus limites: [Viabilidade da integração Alexa](docs/alexa-feasibility.md).

Verificação local: `npm ci && npm test`. Os testes usam dispositivos e transporte Amazon simulados e não produzem áudio; o teste MCP usa stdio real.
