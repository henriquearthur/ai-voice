# Jarvis

## Instalar com o Claude Code

Depois de clonar o repositório, abra o Claude Code na pasta e diga: **"Siga o INSTALAR-COM-CLAUDE.md"**. Ele confere os requisitos, instala o modo mínimo (dashboard e voz no Mac) e pergunta antes de mexer em qualquer configuração sua. Veja [INSTALAR-COM-CLAUDE.md](INSTALAR-COM-CLAUDE.md).

**O Jarvis mora no seu Mac.** Ele escuta o que você fala, entrega o pedido aos agentes de código que estão trabalhando no herdr e responde em voz alta, no Mac ou na Echo da sala. Tem um super app com a conversa, a agenda e a telemetria, um maestro que nunca desliga e um painel que mostra cada serviço respirando.

Você fala "Jarvis, roda os testes e me avisa", levanta da cadeira e ouve a resposta quando ela fica pronta. Sem palavra de ativação na nuvem, sem gravar nada fora do Mac: a transcrição é no próprio aparelho.

> [!NOTE]
> O Jarvis nasceu como fork do [AI Voice](https://github.com/henriquearthur/ai-voice), de Henrique Arthur (MIT), que teve a ideia original de dar voz aos agentes pela Echo. Aqui ele virou um monorepo Bun + Turborepo, com Effect 4 e SvelteKit, e cresceu em escuta, maestro, app nativo e telemetria.

## Como a voz flui

```text
  você fala
     │
     ▼
┌──────────────┐  transcreve no Mac (pt-BR)  ┌──────────────────────┐
│    Escuta    │ ─────────────────────────▶ │  herdr: o maestro e  │
│ barra de menu│   "[voz do ...] pedido"     │  os agentes de código│
└──────────────┘                             └──────────┬───────────┘
     ▲  corta a fala do Jarvis                          │ chamam as tools do MCP
     │  quando você interrompe                          ▼
     │                                       ┌──────────────────────┐
     │                                       │  MCP ai-voice        │
     │                                       │  speak · grokbot_send│
     │                                       └──────────┬───────────┘
     │                                                  │
     │                      ┌───────────────────────────┼──────────────────┐
     │                      ▼                           ▼                  ▼
     │            Kokoro local (7349)            Echo (Alexa)        Grok Bot
     └──────────  fala no Mac, ou `say`          opcional            resposta volta
                                                                     pelo callback (7348)

  Coletor (7352) observa a escuta e o herdr ──▶ OTLP (4318) ──▶ Grafana (7351) e a aba Telemetria
```

## O que tem aqui

| Caminho | O que é |
| --- | --- |
| `apps/dashboard` | O super app do Jarvis, em SvelteKit e Effect: conversa, agenda, lembretes, ir (Mapas) e telemetria. Roda em `127.0.0.1:7350`. |
| `apps/desktop` | O **Jarvis.app**: casca nativa em Swift com WKWebView em volta do dashboard. Abre de qualquer lugar com **⌃⌥J**. |
| `apps/escuta` | A **Escuta**: app Swift de barra de menus que ouve sempre, transcreve no Mac e entrega a fala aos agentes do herdr. Se você fala enquanto o Jarvis fala, ele se cala e escuta. |
| `apps/mcp` | O **MCP ai-voice**: as tools `speak`, `list_devices` e `grokbot_send`, as tools do Mac (Lembretes, Calendário, Mapas, ligação) e o servidor de callback do Grok Bot. |
| `apps/maestro` | O **maestro**: o agente sempre ligado no herdr, com fila de eventos (`127.0.0.1:7353`), vigia que recria o agente se ele sumir e memória que sobrevive à compactação. |
| `apps/coletor` | O coletor de telemetria: segue os eventos da escuta e o estado do herdr e dos LaunchAgents, exporta por OTLP e serve o retrato em `127.0.0.1:7352/estado`. |
| `services/telemetria` | Grafana LGTM em Docker (OTel Collector, Prometheus, Tempo, Loki e Grafana num contêiner só, só em `127.0.0.1`). |
| `services/tts` | A voz do Jarvis: [Kokoro-82M](https://huggingface.co/mlx-community/Kokoro-82M-bf16) via `mlx-audio`, em pt-BR, na porta 7349. |
| `services/bin`, `services/launchd` | Os comandos de `~/.local/bin` (`jarvis-fala`, `jarvis-avisa`, `jarvis-mcp-stdio`...) e os modelos de LaunchAgent. |
| `packages/alexa` | Sessão, Echos e fala da Alexa (Effect 4). |
| `packages/apple` | Lembretes, Calendário, Mapas e Telefone pelo `osascript` e por um helper nativo. |
| `packages/voice` | Fala no Mac: Kokoro primeiro, `say` como reserva, uma fala por vez com trava compartilhada. |
| `packages/grokbot` | Envio para o Grok Bot, no máximo uma vez. |
| `packages/telemetry` | Camada de OpenTelemetry comum e a sonda de saúde `jarvis-sonda`. |
| `packages/announce` | Transforma eventos dos agentes em avisos curtos e seguros em pt-BR. |

## Requisitos

Confira antes de começar. O `scripts/setup.sh` também confere e avisa o que falta.

| Peça | Versão | Para quê | Como instalar |
| --- | --- | --- | --- |
| macOS | 26 ou mais novo para a Escuta (SpeechAnalyzer); o resto roda em versões anteriores | Tudo | |
| Apple Silicon (M1 ou mais novo) | | A voz Kokoro (MLX) só roda nele; sem ele a fala cai no `say` | |
| [Bun](https://bun.sh) | 1.3 ou mais novo (o repositório fixa `bun@1.3.14` em `packageManager`) | Workspace, dashboard, MCP, maestro, coletor | `brew install oven-sh/bun/bun` |
| Xcode Command Line Tools (Swift) | as do macOS 26 | Compilam a Escuta, o Jarvis.app e o helper do Calendário | `xcode-select --install` |
| [uv](https://docs.astral.sh/uv/) ou Python 3.12 | Python 3.12 | Servidor de voz Kokoro (venv e modelo em `~/.local/share/jarvis/tts`) | `brew install uv` |
| [Docker](https://orbstack.dev) (OrbStack ou Docker Desktop) | qualquer recente | Só a telemetria (Grafana LGTM) | `brew install orbstack` |
| [herdr](https://herdr.dev) | o mais recente | A Escuta e o maestro entregam os pedidos aos agentes dentro dele; deve estar no `PATH` ou em `~/.local/bin/herdr` | veja o site do herdr |
| [Claude Code](https://claude.com/claude-code) | o mais recente (`claude` no `PATH`) | Os agentes, o registro do MCP e os hooks de fala | veja a documentação do Claude Code |
| [Tailscale](https://tailscale.com) | opcional | Acessar o dashboard de outros aparelhos e expor o callback do Grok Bot (`tailscale funnel`) | `brew install --cask tailscale` |
| Conta Amazon com uma Echo | opcional | Falar na sala | |
| Grok Bot | opcional | Pesquisa em redes sociais, resposta pelo callback | |

## Setup

### 1. Clonar e rodar o setup

```sh
git clone https://github.com/fernandoeeu/jarvis.git ~/jarvis   # repositório privado: aceite o convite de colaborador antes
cd ~/jarvis
./scripts/setup.sh --dry-run   # mostra o que faria, sem mudar nada
./scripts/setup.sh             # ou: bun run setup
```

O `scripts/setup.sh` é idempotente: rode de novo depois de cada `git pull`. Ele confere os pré-requisitos, roda `bun install` e instala:

- a voz Kokoro em `~/.local/share/jarvis/tts` (LaunchAgent `dev.jarvis.tts`, porta 7349);
- os comandos `jarvis-fala`, `jarvis-fala-resposta`, `jarvis-avisa` e `jarvis-mcp-stdio` em `~/.local/bin`;
- o dashboard como LaunchAgent `dev.jarvis.dashboard` (porta 7350);
- a Escuta em `~/.local/share/jarvis/bin/Escuta.app` (LaunchAgent `dev.jarvis.escuta`), só se o herdr existir;
- o MCP `ai-voice` no Claude Code, se o `claude` existir e o MCP ainda não estiver registrado.

| Flag | Efeito |
| --- | --- |
| `--com-echo` | Usa a Echo: pergunta o marketplace e a Echo padrão. |
| `--com-grok` | Instala o callback do Grok Bot (`dev.jarvis.callback`, porta 7348). |
| `--com-escuta` | Instala a Escuta mesmo sem o herdr no `PATH`. |
| `--sem-voz`, `--sem-dashboard`, `--sem-escuta`, `--sem-mcp` | Pula essa parte. |
| `--sim`, `-y` | Não pergunta nada; usa o arquivo de config, o ambiente e os padrões. |

As respostas ficam em `~/.config/jarvis/jarvis.env`, sem segredos. No fim, o setup lista o que falta fazer à mão.

### 2. Peças que o setup não instala

Cada uma tem seu instalador, também idempotente:

```sh
apps/desktop/scripts/instalar.sh      # Jarvis.app em ~/Applications (--nao-abrir para não abrir)
services/telemetria/install.sh        # LaunchAgent dev.jarvis.telemetria: sobe o Grafana LGTM e a sonda
apps/coletor/scripts/instalar.sh      # LaunchAgent dev.jarvis.coletor (--desinstalar para remover)
apps/maestro/install.sh --dry-run     # mostra os plists do maestro
apps/maestro/install.sh               # LaunchAgents dev.jarvis.eventos e dev.jarvis.maestro
apps/maestro/install.sh --hooks       # imprime os hooks para colar no ~/.claude/settings.json
```

O instalador do maestro não mexe no `settings.json`: os hooks você cola à mão. As rotinas do maestro partem de `apps/maestro/rotinas.example.json`.

### 3. A Echo (opcional)

```sh
bun apps/mcp/src/main.ts login     # abre um proxy em http://127.0.0.1:3456/ para entrar na Amazon
bun apps/mcp/src/main.ts devices   # lista as Echos, sem tocar som
```

A sessão fica em `~/.local/share/ai-voice/`, só com permissão do dono. Ela guarda tokens da sua conta: não compartilhe nem versione essa pasta. Detalhes em [Como a integração com a Alexa funciona](docs/alexa-integration.md).

## Serviços e portas

Tudo escuta só em `127.0.0.1`.

| Porta | Serviço | LaunchAgent |
| --- | --- | --- |
| 7347 | MCP por HTTP em modo dev (`bun run dev` em `apps/mcp`) | — |
| 7348 | Callback do Grok Bot | `dev.jarvis.callback` |
| 7349 | Voz Kokoro (TTS) | `dev.jarvis.tts` |
| 7350 | Dashboard (super app) | `dev.jarvis.dashboard` |
| 7351 | Grafana, painel Jarvis | `dev.jarvis.telemetria` |
| 7352 | Coletor de telemetria | `dev.jarvis.coletor` |
| 7353 | Fila de eventos do maestro | `dev.jarvis.eventos` |
| 4318 | OTLP HTTP (gRPC em 4317) | contêiner `jarvis-telemetria` |
| 9090 | Prometheus | contêiner `jarvis-telemetria` |

A Escuta (`dev.jarvis.escuta`) e o vigia do maestro (`dev.jarvis.maestro`, a cada 60 s) não abrem porta.

Para reiniciar qualquer um: `launchctl kickstart -k gui/$(id -u)/<label>`.

## Rodando cada app

Comandos a partir da raiz do repositório.

**Dashboard**

```sh
bunx turbo run dev --filter=@jarvis/dashboard   # modo dev
cd apps/dashboard && bun run app:install        # build de produção como LaunchAgent (porta 7350)
```

Telas: `/conversa`, `/agenda`, `/lembretes`, `/ir`, `/telemetria` e `/` (Alexa). Ele lê as variáveis `AI_VOICE_*` (veja `apps/dashboard/.env.example`) e não tem autenticação própria: deixe-o numa máquina e numa rede em que você confia.

**Jarvis.app**

```sh
apps/desktop/scripts/instalar.sh
```

Abre o dashboard numa janela nativa. **⌃⌥J** traz o Jarvis para a frente de qualquer app. Por padrão aponta para `http://127.0.0.1:7350/`; `JARVIS_DASHBOARD_URL` muda isso.

**Escuta**

```sh
cd apps/escuta
scripts/instalar.sh --carregar                            # compila, monta o Escuta.app e carrega o LaunchAgent
launchctl kickstart -k gui/$(id -u)/dev.jarvis.escuta    # reiniciar
launchctl bootout gui/$(id -u)/dev.jarvis.escuta         # desligar até o próximo login
swift test
```

Ajustes, logs e testes sem microfone estão em [`apps/escuta/README.md`](apps/escuta/README.md).

**MCP ai-voice**

```sh
bun apps/mcp/src/main.ts                 # stdio, como os clientes MCP usam (ou: bun run voice)
cd apps/mcp && bun run dev               # HTTP em 127.0.0.1:7347/mcp, com recarga
cd apps/mcp && bun run callback          # servidor de callback do Grok Bot
```

Para registrar no Claude Code à mão (o setup já faz isso):

```sh
claude mcp add ai-voice --scope user --env AI_VOICE_ENABLE_SPEECH=1 -- ~/.local/bin/jarvis-mcp-stdio
```

A fala só sai com `AI_VOICE_ENABLE_SPEECH=1`. Na Echo, defina `AI_VOICE_DEFAULT_DEVICE=<serial-da-sua-echo>`. As tools do Mac só existem no stdio, porque o HTTP não tem autenticação. Codex, Cursor e outros clientes: veja a [referência de configuração](docs/configuration.md) e [Jarvis pela rede](docs/network.md).

**Maestro**

```sh
cd apps/maestro
bun run eventos   # fila de eventos em 127.0.0.1:7353
bun run vigia     # uma passada do vigia: recria o agente no herdr se ele sumiu
```

Em uso normal, os dois rodam pelos LaunchAgents do `apps/maestro/install.sh`. A memória fica em `~/.local/share/jarvis/maestro`.

**Coletor**

```sh
cd apps/coletor
bun run dev       # com recarga
bun run start
```

**Telemetria**

```sh
docker compose -f services/telemetria/compose.yaml up -d
```

Com o LaunchAgent `dev.jarvis.telemetria`, a sonda sobe o contêiner sozinha quando o coletor não responde.

**Voz**

```sh
jarvis-fala "Olá, eu sou o Jarvis."
```

## Subir e parar tudo

Depois do setup, tudo sobe sozinho a cada login (LaunchAgents). Para usar, basta abrir o **Jarvis.app** (`~/Applications/Jarvis.app`, ou **⌃⌥J** de qualquer app): ele é só a janela do dashboard, os serviços já estão rodando por baixo.

```sh
# ver o que está carregado
launchctl list | grep dev.jarvis

# reiniciar um serviço
launchctl kickstart -k gui/$(id -u)/dev.jarvis.dashboard

# parar tudo (volta no próximo login, ou com o setup/instaladores de novo)
for l in dev.jarvis.escuta dev.jarvis.maestro dev.jarvis.eventos dev.jarvis.callback dev.jarvis.dashboard dev.jarvis.coletor dev.jarvis.telemetria dev.jarvis.tts; do
  launchctl bootout gui/$(id -u)/$l 2>/dev/null
done
docker stop jarvis-telemetria 2>/dev/null

# subir tudo de novo
./scripts/setup.sh --sim
```

Desinstalar: veja [docs/setup.md](docs/setup.md#uninstall).

## Hooks do Claude Code

Os hooks são opcionais e você os cola à mão no `~/.claude/settings.json` (nada edita esse arquivo sozinho):

- `jarvis-avisa` (Notification e Stop) e `jarvis-fala-resposta` (Stop): o Jarvis fala quando uma sessão pede permissão, termina com uma pergunta ou responde a um pedido falado. O trecho pronto está em [docs/setup.md](docs/setup.md). Os dois usam `claude -p --model haiku` para encurtar o texto.
- Maestro: `apps/maestro/install.sh --hooks` imprime os hooks `SessionStart` e `PreCompact` já com os caminhos do seu clone.

## Configuração por pessoa

### Variáveis de ambiente (só os nomes; sem segredos)

O `scripts/setup.sh` grava as principais em `~/.config/jarvis/jarvis.env` (modo 600). Variável de ambiente com o mesmo nome vale mais que o arquivo.

| Variável | Para quê |
| --- | --- |
| `AI_VOICE_ENABLE_SPEECH` | A fala só sai com `1` (o setup já registra o MCP assim) |
| `AI_VOICE_LOCALE` | Idioma da fala (padrão `pt-BR`) |
| `AI_VOICE_OUTPUT` | `mac` ou `echo`: onde falar por padrão |
| `AI_VOICE_TTS_VOICE` | Voz do Kokoro (padrão `pf_dora`) |
| `AI_VOICE_AMAZON_PAGE` | Marketplace da sua conta Amazon (`amazon.com.br`, `amazon.com`...) |
| `AI_VOICE_DEFAULT_DEVICE` | Serial da sua Echo padrão (vazio se não usa Echo) |
| `AI_VOICE_STATE_DIR` | Opcional: onde fica a sessão da Amazon (padrão `~/.local/share/ai-voice`) |
| `JARVIS_CALLBACK_PORT` | Porta do callback do Grok Bot (padrão 7348) |
| `ESCUTA_ORQUESTRADOR` | Nome do agente do herdr que recebe os pedidos falados |
| `ESCUTA_PANE` | Pane do herdr de destino, se quiser fixar um |
| `ESCUTA_MIC` | Partes do nome dos microfones preferidos, em ordem |
| `ESCUTA_STT` | `parakeet` liga o Parakeet em vez do reconhecimento da Apple |
| `JARVIS_DASHBOARD_URL` | URL que o Jarvis.app abre |
| `JARVIS_SIGNING_IDENTITY` | Identidade de assinatura dos apps (padrão "Jarvis Local Signing") |
| `JARVIS_MAESTRO_NOME`, `JARVIS_MAESTRO_DIR`, `JARVIS_MAESTRO_WORKSPACE` | Nome, pasta de memória e workspace do maestro |
| `JARVIS_CONFIG`, `JARVIS_TTS_HOME` | Caminhos do arquivo de config e da voz |

O Grok Bot guarda as chaves no Keychain do macOS; a sessão da Amazon fica em `~/.local/share/ai-voice/`. Nada disso vai para o git.

### O que é específico do Mac do Fernando e você precisa trocar

Os scripts de instalação usam `$HOME` e o caminho do seu clone, então não há caminho absoluto `/Users/fernandodudata` no código (só em logs e testes). O que sobra de pessoal:

1. **Echo e conta Amazon**: o serial da Echo do Fernando não está no repositório. Rode `bun apps/mcp/src/main.ts login` com a sua conta e `bun apps/mcp/src/main.ts devices` para achar a sua; ponha o serial em `AI_VOICE_DEFAULT_DEVICE`. Sem Echo, deixe `AI_VOICE_OUTPUT=mac`.
2. **Grok Bot**: precisa de conta e conector seus. Sem ele, instale sem `--com-grok` e ignore a tool `grokbot_send`. Com ele, use o seu domínio do Tailscale Funnel no conector.
3. **Nome "Fernando"**: o prefixo `[voz do Fernando] ` que a Escuta põe nos pedidos está fixo em `apps/escuta/Sources/Escuta/Router.swift` (linha 28), e as tools `notify_fernando` e `speak_fernando` do callback e os textos do maestro (`apps/maestro/agente/*.in`, `agentes.example.json`) também falam do Fernando. Funciona assim mesmo; troque o nome se quiser. Se mudar o prefixo, ajuste `JARVIS_VOZ_MARCADOR` do hook `jarvis-fala-resposta`.
4. **Microfone**: o padrão da Escuta é `HyperX,iPhone,MacBook` (microfones do Fernando); defina `ESCUTA_MIC` com o nome do seu.
5. **Agentes do herdr**: o nome do agente que recebe os pedidos (`ESCUTA_ORQUESTRADOR`) e as rotinas (`apps/maestro/agentes.example.json`, `rotinas.example.json`) são pontos de partida; copie e adapte aos seus projetos.
6. **Assinatura**: crie o certificado "Jarvis Local Signing" (seção abaixo) ou aceite que o macOS peça as permissões de novo a cada build.
7. **Tailscale**: o dashboard aceita hosts da tailnet (`ts.net` e `100.64/10`); sem Tailscale ele atende só `127.0.0.1` e a LAN.

## Solução de problemas

| Sintoma | O que fazer |
| --- | --- |
| `scripts/setup.sh` para em pré-requisito | Instale o que ele listou e rode de novo; `--dry-run` mostra tudo sem mudar nada |
| Sem voz do Kokoro, o Jarvis fala com o `say` | Mac sem Apple Silicon, ou falta `uv`/Python 3.12; veja `~/.local/share/jarvis/tts/logs/` e `launchctl kickstart -k gui/$(id -u)/dev.jarvis.tts` |
| A Escuta não foi instalada | Falta o herdr no `PATH` ou o macOS é anterior ao 26; instale e rode o setup (ou `--com-escuta`) |
| A Escuta não ouve | Libere Microfone e Reconhecimento de Fala em Ajustes do Sistema > Privacidade e Segurança; reinicie com `launchctl kickstart -k gui/$(id -u)/dev.jarvis.escuta` |
| O macOS pede as permissões a cada compilação | Crie o certificado "Jarvis Local Signing" |
| O dashboard não abre em `127.0.0.1:7350` | `launchctl kickstart -k gui/$(id -u)/dev.jarvis.dashboard` e confira se a porta está livre |
| Erro 5 no `launchctl bootstrap` | O agente anterior ainda não terminou de sair; rode o instalador de novo |
| A aba Telemetria está vazia | Docker precisa estar rodando; `services/telemetria/install.sh` e `apps/coletor/scripts/instalar.sh` |
| A Echo não fala | `bun apps/mcp/src/main.ts devices` deve listá-la; se não, refaça o `login` |
| O MCP `ai-voice` não aparece no Claude Code | `claude mcp list`; registre à mão com o comando da seção MCP |

Mais detalhes em [docs/configuration.md](docs/configuration.md).

## Telemetria

O coletor lê os eventos da Escuta e, a cada 5 s, o herdr (agentes, estados, RAM e CPU) e os LaunchAgents `dev.jarvis.*`. O MCP, o callback e o dashboard exportam seus próprios traces. Tudo vai por OTLP para o Grafana LGTM, com retenção de 3 dias.

| Link | O que mostra |
| --- | --- |
| http://127.0.0.1:7350/telemetria | A aba Telemetria do super app: serviços, agentes do herdr, latência e interrupções, ao vivo. |
| http://127.0.0.1:7351/d/jarvis | O painel Jarvis no Grafana. |
| http://127.0.0.1:9090 | Prometheus. |
| http://127.0.0.1:7352/estado | O último retrato do coletor, em JSON (SSE em `/estado/ao-vivo`). |

## Permissões do macOS e assinatura local

Na primeira vez, o macOS pede permissão. Aceite, ou ligue depois em **Ajustes do Sistema > Privacidade e Segurança**:

| Permissão | Para quem |
| --- | --- |
| Microfone | Escuta |
| Reconhecimento de Fala | Escuta |
| Calendários | Helper do Calendário (agenda do dashboard e tools `calendar_*`) |
| Lembretes | Dashboard e tools `reminders_*` |
| Automação | `osascript` controlando Lembretes, Calendário e Mapas |

O macOS amarra essas permissões à assinatura do app. Com assinatura ad hoc, cada nova compilação parece um app novo e as permissões são pedidas de novo. Para evitar isso, crie uma vez um certificado de assinatura de código autoassinado chamado **Jarvis Local Signing** no Acesso às Chaves (Assistente de Certificado > Criar um Certificado, tipo Assinatura de Código), na keychain de login. Confira com:

```sh
security find-identity -p codesigning
```

Os instaladores da Escuta e do Jarvis.app usam essa identidade automaticamente; `JARVIS_SIGNING_IDENTITY` escolhe outra. Sem nenhuma, eles assinam ad hoc.

## Desenvolvimento

```sh
bun install
bun run check   # tipos em todo o workspace
bun run test
bun run build
```

Rodam pelo Turborepo, em ordem de dependência e com cache. Os testes usam Echos e transporte simulados: não precisam de conta Amazon e não tocam som.

## Documentação

- [Setup no Mac](docs/setup.md): o que o `scripts/setup.sh` instala, os arquivos que grava e como desinstalar.
- [Referência de configuração](docs/configuration.md): variáveis de ambiente, contratos das tools e solução de problemas.
- [Jarvis pela rede](docs/network.md): um servidor em casa para todas as máquinas.
- [Como a integração com a Alexa funciona](docs/alexa-integration.md): as APIs privadas, o que foi validado e os limites.

> [!IMPORTANT]
> O Jarvis é um projeto pessoal e não oficial. A parte da Echo usa as APIs privadas do app da Alexa, via [`alexa-remote2`](https://github.com/Apollon77/alexa-remote), e não tem relação com a Amazon nem aval dela. A Amazon pode mudar essas APIs a qualquer momento.

## Licença

[MIT](LICENSE). Copyright (c) 2026 Henrique Arthur, autor original do AI Voice, e Fernando Antonio pelas mudanças deste fork. Amazon, Alexa e Echo são marcas da Amazon.com, Inc. ou de suas afiliadas.
