# Instalar o Jarvis com o Claude Code

Este arquivo é escrito para o **Claude Code** executar. Se você é o Claude Code: siga os passos abaixo na ordem, em pt-BR, sem pular nenhum. Se você é a pessoa que clonou o repositório: abra o Claude Code nesta pasta e diga "Siga o INSTALAR-COM-CLAUDE.md".

## Regras da instalação

- Responda sempre em pt-BR.
- Use só flags e comandos que existem em `scripts/setup.sh`, `docs/setup.md` e `README.md`. Não invente opções.
- **Pergunte antes de pedir qualquer chave, senha ou token.** Nunca grave segredo no repositório nem em `~/.config/jarvis/jarvis.env` (segredos vão para o Keychain).
- Não instale nada fora do que este roteiro manda, e não use `sudo`.
- Se um passo falhar, mostre o erro e o log, diga o que tentou e pergunte antes de seguir por outro caminho.

## 1. Leia a documentação

Leia `README.md` e `docs/setup.md` **inteiros** antes de rodar qualquer comando.

## 2. Confira os pré-requisitos

Verifique cada item abaixo (por exemplo `sw_vers`, `uname -m`, `bun --version`, `xcode-select -p`, `uv --version` ou `python3.12 --version`, `command -v herdr claude jq docker`) e **mostre ao usuário uma tabela com o que está ok e o que falta, com o comando de instalação de cada faltante, antes de instalar qualquer coisa**.

| Peça | Versão | Observação |
| --- | --- | --- |
| macOS | 26 ou mais novo | A Escuta (SpeechAnalyzer) exige o 26; o resto roda em versões anteriores |
| Apple Silicon | M1 ou mais novo | A voz Kokoro (MLX) só roda nele; sem ele a fala cai no `say` |
| Bun | 1.3 ou mais novo | `brew install oven-sh/bun/bun` |
| Xcode Command Line Tools | as do macOS 26 | `xcode-select --install` |
| uv ou Python 3.12 | Python 3.12 | `brew install uv` |
| herdr | o mais recente | Obrigatório para a Escuta e o maestro; veja o site do herdr |
| Claude Code | o mais recente | `claude` no `PATH` |
| `jq` | qualquer | Usado pelo hook `jarvis-avisa`; `brew install jq` |
| Docker ou OrbStack | qualquer recente | **Só** para a telemetria (Grafana); `brew install orbstack`. Pule se o usuário não quiser telemetria |

Peça ao usuário para instalar (ou autorize a instalação de) o que faltar e só continue quando os itens obrigatórios estiverem ok.

## 3. Setup em modo mínimo

O modo mínimo é: dashboard e voz no Mac, sem Echo, sem Grok Bot e sem Tailscale. Isso já é o padrão do `setup.sh` (as flags `--com-echo` e `--com-grok` ficam de fora), com `AI_VOICE_OUTPUT=mac`.

1. Rode primeiro o simulado e mostre o resultado ao usuário:

   ```sh
   ./scripts/setup.sh --dry-run
   ```

2. Rode o setup real, sem a Escuta por enquanto (ela entra no passo 5):

   ```sh
   ./scripts/setup.sh --sem-escuta
   ```

   O script pergunta algumas coisas no terminal. Em `AI_VOICE_OUTPUT` responda `mac`. Se preferir não responder nada, use `./scripts/setup.sh --sem-escuta --sim`, que usa o arquivo de config, o ambiente e os padrões (`mac`).

3. O script instala os LaunchAgents `dev.jarvis.tts` (porta 7349) e `dev.jarvis.dashboard` (porta 7350), os comandos em `~/.local/bin` e registra o MCP `ai-voice` no Claude Code (escopo user). As respostas ficam em `~/.config/jarvis/jarvis.env`. É idempotente: pode rodar de novo.

## 4. Voz Kokoro e teste

O `setup.sh` baixa o modelo Kokoro em `~/.local/share/jarvis/tts/models/` na primeira vez (pode demorar). Depois confirme:

```sh
curl -s http://127.0.0.1:7349/health
jarvis-fala "Olá, eu sou o Jarvis."
```

Se o `/health` não responder, olhe os logs em `~/.local/share/jarvis/tts/logs/` e `launchctl print gui/$(id -u)/dev.jarvis.tts`. Pergunte ao usuário se ele ouviu a fala.

## 5. Escuta (transcrição por voz) — opcional, exige macOS 26 e herdr

Pergunte se o usuário quer a escuta por voz. Se não, pule este passo.

1. Confirme que o `herdr` está no `PATH` (ou em `~/.local/bin/herdr`) e que o macOS é 26 ou mais novo.
2. Rode `./scripts/setup.sh` de novo, agora sem `--sem-escuta` (ou use `--com-escuta` se o herdr não estiver no `PATH`).
3. Os modelos de transcrição (cerca de 460 MB, em `~/Library/Application Support/FluidAudio/Models`) baixam no **primeiro uso** da Escuta. Avise o usuário, peça para ele falar uma frase e confira o download e o log em `~/.local/share/jarvis/escuta/logs/`.
4. Avise que o macOS vai pedir as permissões de Microfone e Reconhecimento de Fala; ele precisa aceitar na hora.

## 6. Ajuste o que é específico do Fernando

Este projeto nasceu na máquina do Fernando. Mostre ao usuário cada item e troque pelo equivalente dele ou deixe desligado:

- **Echo (Amazon):** não use. Mantenha `AI_VOICE_OUTPUT=mac` em `~/.config/jarvis/jarvis.env` e não rode `--com-echo`. O serial da Echo do Fernando não está no repositório.
- **Grok Bot:** não use. Não rode `--com-grok`; sem ele não existe o LaunchAgent `dev.jarvis.callback`. As tools `grokbot_send` do MCP ficam sem uso.
- **Marcador `[voz do Fernando]`:** é o prefixo que a Escuta põe nos pedidos falados, fixo em `apps/escuta/Sources/Escuta/Router.swift`. Funciona assim mesmo. Se o usuário quiser o nome dele, pergunte o nome, troque lá e ajuste `JARVIS_VOZ_MARCADOR` do hook `jarvis-fala-resposta`. Textos do maestro (`apps/maestro/agente/*.in`) também falam do Fernando.
- **Microfone (`ESCUTA_MIC`):** o padrão da Escuta é `HyperX,iPhone,MacBook` (microfones do Fernando). Pergunte qual microfone o usuário usa (ou rode `system_profiler SPAudioDataType`), grave partes do nome em `ESCUTA_MIC` no `~/.config/jarvis/jarvis.env` e rode `./scripts/setup.sh` de novo. Vazio usa o microfone embutido.
- **Voz:** `AI_VOICE_TTS_VOICE` aceita `pf_dora` (padrão), `pm_alex` ou `pm_santa`. Pergunte se o usuário quer trocar.

## 7. Hooks do Claude Code (opcional, só com aprovação)

Os hooks fazem o Jarvis avisar em voz alta quando uma sessão pede permissão ou termina com pergunta. Nada edita o `~/.claude/settings.json` sozinho, e você também não deve fazer isso sem aprovação.

1. Mostre ao usuário este JSON (de `docs/setup.md`) e explique o que cada hook faz. Eles dependem de `jq` e usam `claude -p --model haiku` para encurtar o texto:

   ```json
   {
     "hooks": {
       "Notification": [{ "hooks": [{ "type": "command", "command": "~/.local/bin/jarvis-avisa", "async": true, "timeout": 60 }] }],
       "Stop": [
         { "hooks": [{ "type": "command", "command": "~/.local/bin/jarvis-avisa", "async": true, "timeout": 60 }] },
         { "hooks": [{ "type": "command", "command": "~/.local/bin/jarvis-fala-resposta", "timeout": 10 }] }
       ]
     }
   }
   ```

2. Pergunte: "Posso mesclar isso no seu `~/.claude/settings.json`?"
3. Só com a resposta afirmativa: faça um backup (`cp ~/.claude/settings.json ~/.claude/settings.json.bak`), mescle com `jq` **adicionando** às listas `Notification` e `Stop` que já existirem, sem apagar nem sobrescrever nenhuma outra chave ou hook, e mostre o diff final.
4. Os hooks do maestro (`SessionStart` e `PreCompact`) saem de `apps/maestro/install.sh --hooks`; só ofereça isso se o usuário for instalar o maestro, com a mesma regra de aprovação.

## 8. Peças extras (só se o usuário pedir)

Cada uma tem instalador próprio, listado no README: `apps/maestro/install.sh`, `apps/coletor/scripts/instalar.sh` e `services/telemetria/install.sh` (esta exige Docker/OrbStack). Tailscale também é opcional e fica de fora do modo mínimo. Não instale nada disso sem o usuário pedir.

## 9. Abra o Jarvis e relate

1. Instale e abra o app nativo:

   ```sh
   apps/desktop/scripts/instalar.sh
   ```

   Ele cria `~/Applications/Jarvis.app` (atalho global **⌃⌥J**). Use `--nao-abrir` se quiser só instalar.

2. Confirme os serviços:

   ```sh
   launchctl list | grep dev.jarvis
   curl -s http://127.0.0.1:7349/health
   curl -sI http://127.0.0.1:7350/ | head -1
   ```

   Esperado no modo mínimo: `dev.jarvis.tts` e `dev.jarvis.dashboard` (mais `dev.jarvis.escuta` se instalada). Avise que o macOS pode pedir permissões de Calendário, Lembretes e Automação no primeiro uso.

3. Escreva ao usuário um relatório curto em pt-BR com: o que está funcionando, o que ficou de fora de propósito (Echo, Grok Bot, Tailscale, telemetria, maestro, hooks, se for o caso), o que ele ainda precisa fazer à mão e onde estão os logs. Para desinstalar, aponte para `docs/setup.md#uninstall`.
