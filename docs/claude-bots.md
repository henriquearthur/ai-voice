# Claude Bots: a colmeia do Jarvis

Especificação da mente coletiva do Jarvis: uma fábrica de software autônoma, 100% Claude Code, sempre disponível. O Fernando fala com uma voz só, não escolhe bot e não precisa lembrar quem é quem.

Este documento descreve a arquitetura que está sendo implementada. Os contratos das seções 2 a 5 são a fonte da verdade para as frentes paralelas; quem mudar um contrato atualiza este arquivo no mesmo commit.

## 0. Princípios

- Assunto vira tarefa, não vira bot. Os especialistas fixos de hoje (`telemetria`, `rust-core`, `escuta-voz`, `otimizacao`) saem: o trabalho deles vira card no quadro e é feito por workers efêmeros.
- Existem poucos bots fixos, definidos por papel: Chefe, Despachante e Vigia.
- Uma voz só: só o Chefe fala com o Fernando (`speak` e `jarvis-fala`). Os outros bots e os workers só escrevem no quadro e na colmeia.
- Todo estado compartilhado mora em `~/.jarvis/`, fora do repo. Segredos nunca entram no repo.
- Nada de `bypassPermissions` nem de pretrust global. Hooks novos ficam só no `.claude/settings.json` do projeto, nunca no `~/.claude` global.
- Workers são efêmeros, recebem um kit de skills e ferramentas e terminam com um VERDICT.

Origem das ideias, adaptadas ao Jarvis: o Chief of Staff único e a lista viva do time vêm do OpenMausBot; o kanban com claim, lease e reconciliação vem do Hermes; a conversa entre agentes com allowlist, ping-pong limitado e `REPLY_SKIP`, o heartbeat e o memoryFlush vêm do OpenClaw; o coordenador que nunca executa vem do herdr-projects; o brief e o VERDICT vêm do pstack.

## 1. Papéis fixos

Os três são sessões Claude Code em panes do herdr. As instruções de cada um ficam em `apps/claude-bots/<papel>/`. Quem mantém os panes de pé é o vigia de processos do `apps/maestro` (LaunchAgent `dev.jarvis.maestro`), que já sabe recriar pane, retomar sessão com `--resume` e nomear o pane. Cada pane sobe com `JARVIS_BOT=<papel>` no ambiente; hooks, ferramentas MCP e a trava de voz usam essa variável para saber quem chamou.

| Papel | Faz | NÃO faz |
|---|---|---|
| **Chefe** (`chefe`) | Recebe tudo que vem do Fernando (voz pela Escuta, dashboard, iPhone, rotinas). Transforma cada pedido em card (`quadro_criar`) com brief completo. Resume entregas e bloqueios para o Fernando. É o **único** que fala. Escreve `colmeia.md` e consolida o que os workers pedem para lembrar. Decide e pergunta ao Fernando o que precisa de humano. | Não lê código, não edita, não roda build nem teste. Não lança worker (isso é do Despachante). Não prende o turno: responde em segundos. |
| **Despachante** (`despachante`) | Pega cards abertos (`quadro_pegar`), escolhe o kit e o modelo, lança o worker em segundo plano, respeita os limites de concorrência e de recurso, encadeia a verificação (worker de implementação seguido de um worker que lê o diff) e conclui o card (`quadro_concluir`) com o VERDICT. | Não fala com o Fernando. Não executa o trabalho do card ele mesmo. Não cria card por conta própria, exceto os subcards de verificação e de continuação de um card que ele já pegou. |
| **Vigia** (`vigia`) | Cuida da saúde da colmeia: confere leases vencidos e a reconciliação, card parado sem evento, pane idle com card pego, `fala.lock` preso, serviços `dev.jarvis.*` caídos e consumo do Mac. Tudo que acha vira card ou evento para o Chefe. | Não fala. Não mata processo de outro bot sem um card aprovado pelo Chefe. Não implementa correção: abre o card. |

Por que três: com só um bot fixo, o turno do Chefe fica preso em despacho e ele deixa de estar sempre disponível para o Fernando. Um quarto papel fixo, como revisor ou pesquisador, voltaria ao erro de ter um bot por assunto; revisão e pesquisa são kits de worker. O Vigia é um papel separado porque a vigilância é periódica e não pode depender de o Chefe ou o Despachante estarem livres.

A parte mecânica, que não precisa de LLM (tick, reconciliação de lease, retomada de pane, entrega de mensagem a pane idle), roda como código determinístico no `apps/maestro`. O bot Vigia recebe só o que precisa de julgamento.

## 2. Quadro

Banco SQLite em `~/.jarvis/quadro.db`, em modo WAL, com `busy_timeout`. A biblioteca única fica em `packages/quadro`; o MCP, o vigia de processos, os hooks e o dashboard usam só ela, sem SQL espalhado pelo código.

### 2.1 Tabelas

```sql
CREATE TABLE cards (
  id            TEXT PRIMARY KEY,        -- "c-<base36>"
  titulo        TEXT NOT NULL,
  brief         TEXT NOT NULL,           -- brief no formato da seção 3.3
  kit           TEXT NOT NULL,           -- backend | ui | devops | seguranca | pesquisa
  estado        TEXT NOT NULL CHECK (estado IN ('aberto','pego','feito','falhou','bloqueado')),
  dono          TEXT,                    -- quem pegou ("despachante", "w:<card>")
  lease_ate     TEXT,                    -- ISO-8601; só com estado = 'pego'
  criado_por    TEXT NOT NULL,           -- chefe | despachante | vigia | fernando | migracao
  verdict       TEXT,                    -- PASS | ISSUES | BLOCKED
  resultado     TEXT,                    -- resumo da entrega (commits, arquivos, números)
  criado_em     TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);

CREATE TABLE eventos (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT REFERENCES cards(id),     -- NULL para evento da colmeia sem card
  ts      TEXT NOT NULL,
  autor   TEXT NOT NULL,
  tipo    TEXT NOT NULL,                 -- criado | pego | progresso | concluido | reaberto | bloqueio | aviso | lembrar
  texto   TEXT NOT NULL
);

CREATE TABLE mensagens (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,
  de      TEXT NOT NULL,
  para    TEXT NOT NULL,                 -- chefe | despachante | vigia | todos
  thread  TEXT NOT NULL,
  turno   INTEGER NOT NULL,              -- 1..5 dentro da thread
  texto   TEXT NOT NULL,
  lida_em TEXT
);
```

### 2.2 Estados

```
aberto ──pegar──▶ pego ──concluir(PASS)──────────▶ feito
  ▲                 │──concluir(ISSUES, sem saída)─▶ falhou
  │                 │──concluir(BLOCKED)───────────▶ bloqueado ──Chefe/Fernando──▶ aberto
  └──lease vencido──┘
```

- `pegar` é atômico (`BEGIN IMMEDIATE`): o card mais antigo em `aberto`, filtrado por kit se pedido, vai a `pego` com `dono` e `lease_ate = agora + 15 min`.
- Qualquer evento do dono sobre o card renova o lease por mais 15 min.
- **Reconciliação** (tick de 10 s no `apps/maestro`): card `pego` com `lease_ate` vencido volta a `aberto`, com `dono` e `lease_ate` limpos e um evento `reaberto`. Na terceira reabertura do mesmo card, ele vai a `bloqueado` e o Chefe recebe um evento.
- `bloqueado` sempre gera um evento `bloqueio` para o Chefe, que decide se pergunta ao Fernando.

### 2.3 Ferramentas MCP (servidor ai-voice, transporte stdio)

| Ferramenta | Parâmetros | Retorno |
|---|---|---|
| `quadro_criar` | `titulo`, `brief`, `kit` | o card criado (`estado: aberto`) |
| `quadro_listar` | `estado?`, `kit?`, `limite?` (padrão 20) | lista de cards, mais recentes primeiro |
| `quadro_pegar` | `kit?` | o card pego, ou vazio se não houver card aberto |
| `quadro_concluir` | `id`, `verdict` (`PASS`/`ISSUES`/`BLOCKED`), `resultado` | o card no estado final |
| `colmeia_enviar` | `para`, `texto`, `thread?` | a mensagem gravada |
| `colmeia_log` | `desde?` (id), `limite?` | mensagens e eventos recentes |

O autor e o dono saem de `JARVIS_BOT`, herdado pelo processo MCP da sessão. Uma sessão sem `JARVIS_BOT` grava como `fernando`.

## 3. Workers efêmeros

### 3.1 Como rodam

O worker é um subagente nativo do Claude Code, lançado pelo Despachante com a ferramenta `Agent`, `run_in_background: true`, `model` explícito e `isolation: "worktree"` sempre que escreve arquivo. Ele morre ao entregar. A profundidade é 1: worker não lança worker.

### 3.2 Kits

Cada kit é um arquivo `.claude/agents/worker-<kit>.md` com frontmatter `name`, `description`, `model` e `tools`:

| Kit | Para quê | Modelo padrão |
|---|---|---|
| `worker-backend` | TypeScript/Effect, Bun, Rust, Swift: implementação e testes | sonnet |
| `worker-ui` | dashboard SvelteKit, componentes e iPhone, com as skills de design (impeccable, design-taste-frontend, emil-design-eng) | sonnet |
| `worker-devops` | LaunchAgents, scripts, TTS, telemetria e operação do Mac (processo pesado com `nice` e lock) | sonnet |
| `worker-seguranca` | revisão de segurança e leitura de diff com VERDICT; só leitura | opus |
| `worker-pesquisa` | busca no código e na web, e `grokbot_send` para Reddit e X | haiku |

O Despachante pode subir ou descer o modelo pela regra global: haiku para busca e tarefa mecânica, sonnet para implementação, opus para arquitetura, depuração difícil e revisão crítica.

**Ferramentas bloqueadas em todo kit**: `Agent` (sem aninhar), `speak`, `phone_call`, `herdr_send`, `herdr_key`, `colmeia_enviar`, `quadro_criar` e `quadro_pegar`. O worker não fala, não mexe em pane, não conversa com bot e não cria trabalho. O que ele quiser propor vai no texto da entrega, e o Despachante ou o Chefe decidem.

**Limites**:
- no máximo 6 workers vivos ao mesmo tempo, e no máximo 1 com opus;
- 1 por recurso pesado (build, benchmark, modelo, container), com lock em `~/.jarvis/locks/<recurso>.lock` e `nice`;
- tempo máximo por card: o campo TEMPO do brief, com 45 min de padrão. Card maior vira subcards.

### 3.3 Brief e VERDICT

Todo card carrega um brief com estas seções:

```
OBJETIVO:   uma frase com o resultado esperado
ESCOPO:     arquivos e pastas que o worker pode tocar (exclusivos)
CONTEXTO:   o que já existe, links para cards anteriores
CRITÉRIOS:  como saber que ficou pronto
VERIFICAR:  comandos de teste e checagem
TEMPO:      limite em minutos
PROIBIDO:   o que não pode (push, merge, prod, fala, arquivos fora do escopo)
FORMATO:    o que devolver
```

A resposta final do worker começa com `VERDICT: PASS|ISSUES|BLOCKED`, seguida de commits, arquivos, como verificar e um bloco opcional `## Lembrar` com fatos duráveis. O Despachante grava isso com `quadro_concluir`. O bloco `## Lembrar` vira um evento `lembrar`, que o Chefe consolida.

Fluxo de verificação: um card de código com PASS do worker gera um segundo worker (`worker-seguranca` ou outro do mesmo kit) que lê o diff. O card só vai a `feito` quando o verificador também der PASS.

Commits são atômicos, só dos arquivos do escopo, no worktree. O worker nunca faz push nem merge.

## 4. Mente coletiva

### 4.1 Arquivos de memória (`~/.jarvis/memoria/`)

| Arquivo | Quem escreve | Limite | Para quê |
|---|---|---|---|
| `colmeia.md` | Chefe | 8000 caracteres | decisões, convenções e estado do projeto (equivale ao company.md) |
| `fernando.md` | Fernando, ou o Chefe transcrevendo literalmente um "lembra que..." dele | 1375 caracteres | preferências e regras do Fernando |
| `bots/<papel>.md` | o próprio bot fixo | 2200 caracteres | caderno de cada um: pendências e contexto do papel |

Quando um arquivo passa do limite, quem escreve resume. O hook corta no limite ao injetar e avisa o autor.

O worker não recebe caderno. Ele recebe, no brief, um snapshot congelado de `colmeia.md` e de `fernando.md` tirado no momento em que o card foi pego. Assim a memória mudar no meio do trabalho não afeta a tarefa.

### 4.2 Injeção por hooks do projeto

Os hooks ficam em `.claude/settings.json` do repo. Eles só agem quando `JARVIS_BOT` está definido; qualquer outra sessão sai calada.

- **SessionStart** (`startup|resume|compact|clear`): injeta como `additionalContext` o papel, `colmeia.md`, `fernando.md`, o caderno do bot, o resumo do quadro (contagem por estado, cards pegos com dono e idade, últimos concluídos) e "quem faz o quê" (os 3 bots com estado e os workers vivos por card).
- **UserPromptSubmit**: injeta só o que mudou desde o turno anterior (cards que mudaram de estado e mensagens novas para este bot), com no máximo 1500 caracteres.
- **PreCompact** (memoryFlush): grava no caderno do bot, entre marcadores automáticos, um retrato da sessão tirado do transcript. É a mesma técnica do `apps/maestro/src/hooks/pre-compact.ts`.

## 5. Conversa entre bots

- O canal é a tabela `mensagens`, espelhada linha a linha em `~/.jarvis/colmeia.ndjson`, que o dashboard lê. Cada linha tem `{ts, de, para, thread, turno, texto}`.
- Allowlist: chefe⇄despachante, chefe⇄vigia e despachante⇄vigia. Workers não estão na lista.
- Ping-pong: no máximo 5 turnos por thread. No sexto, a mensagem é recusada e o Chefe recebe um evento. Responder `REPLY_SKIP` encerra a thread sem resposta.
- Entrega: o UserPromptSubmit do destinatário injeta as mensagens não lidas. Se o destinatário estiver idle, o tick do `apps/maestro` manda a ele um aviso curto pelo herdr, depois do settle e com o lock por pane que o `herdr_send` já tem.
- Tudo é visível: o Fernando vê a colmeia inteira no dashboard, sem precisar perguntar.

## 6. Sempre disponível

- **launchd**: o `dev.jarvis.maestro` continua sendo o daemon. O vigia de processos passa a manter os panes `chefe`, `despachante` e `vigia` no lugar do maestro e dos especialistas, com a mesma recriação, o `--resume` e o prompt de retomada do papel.
- **Tick de 10 s** (código, sem LLM): reconciliação de leases, entrega de mensagens, rotinas (`rotinas.json`) e a guarda do `fala.lock`.
- **Retomada com card aberto**: se um bot está idle com card `pego` em seu nome e o card não tem evento há 10 min, o tick manda `[tick] retome o card <id>: <título>`. Se há cards em `aberto` e o Despachante está idle, o tick manda `[tick] N cards abertos`.
- **Heartbeat de 30 min** ao bot Vigia: `[heartbeat] confira a colmeia`. Sem nada a fazer, ele responde `HEARTBEAT_OK`, e essa resposta nunca vira fala.
- Os bots fixos seguem a regra de nunca prender o turno: todo trabalho vai para worker em segundo plano.

## 7. Voz única e fila de fala

O que acontece hoje: os 5 agentes falam (os especialistas têm `jarvis-fala` liberado, `voz-sempre` contém `*` e o hook global `jarvis-avisa` fala por qualquer sessão), a fila do `fala.lock` enche, e o benchmark do rust-core segura o `fala.lock` por um tempo longo.

Correção:

1. **Só o Chefe fala.** `jarvis-fala` e o `speak` do MCP conferem `JARVIS_BOT`: com valor diferente de `chefe`, não tocam nada e gravam um evento `aviso` no quadro. O Chefe decide o que vira fala. Os hooks `jarvis-fala-resposta` e `jarvis-avisa` também ficam calados em sessão com `JARVIS_BOT` diferente de `chefe`. Não é preciso editar o settings global: a checagem fica nos próprios scripts.
2. **`voz-sempre`** volta a conter só o id da sessão do Chefe, sem `*`.
3. **O Chefe agrega.** No máximo uma fala a cada 20 s. Avisos que chegam juntos viram uma frase só, e `HEARTBEAT_OK` e `REPLY_SKIP` nunca são falados.
4. **TTL na fila.** Uma fala que esperou mais de 60 s pelo lock é descartada (`motor=descartada motivo=ttl` no `fala.log`). O `jarvis-cala` continua sendo o único ponto de interrupção.
   Implementado (passo 2): a trava fica no `services/bin/jarvis-fala` (descarta, grava `motivo=bot:<bot>` no `fala.log` e manda `quadro msg <bot> chefe "<texto>"` se o CLI existir; `JARVIS_QUADRO_CLI` troca o caminho), com cópia da checagem em `jarvis-avisa` e `jarvis-fala-resposta`. Sessão sem `JARVIS_BOT` (a sessão jarvis e os panes antigos) mantém o comportamento atual. O TTL fica no `services/tts/fala-kokoro.sh` (`JARVIS_FALA_TTL_S`, padrão 60). Teste: `services/tts/test_voz_unica.sh`.
   **Passo pendente, só ao aposentar os panes antigos:** remover o `*` de `~/.local/share/jarvis/voz-sempre` e deixar só o id da sessão do Chefe (`echo <id-do-chefe> > ~/.local/share/jarvis/voz-sempre`). Enquanto o `*` estiver lá, os panes sem `JARVIS_BOT` continuam falando.
5. **Benchmark fora do `fala.lock`.** O bench usa só `~/.jarvis/locks/bench.lock` e saída nula. Ele nunca envolve uma rodada inteira em `lockf fala.lock`. Uma medição audível só acontece a pedido do Fernando, e cada amostra pega e solta o lock como uma fala comum. A guarda do tick confere o dono do `fala.lock`: se o lock está preso há mais de 90 s por algo que não é a cadeia normal de fala (`fala-kokoro.sh`, `afplay`, `say`, `curl`), o tick abre um evento para o Vigia e avisa o Chefe.

## 8. Escuta, dashboard e iPhone

- **Escuta**: o alvo padrão (`orchestratorName`, hoje `"maestro"` em `apps/escuta/Sources/Escuta/Config.swift`) passa a ser `chefe`. A chamada pelo nome no começo da frase vale só para os 3 bots fixos. O "sim"/"não" para quem pede aprovação e o `asks.jsonl` continuam como estão.
- **Dashboard `/quadro`**: um kanban por estado (aberto, pego, bloqueado, feito, falhou), o detalhe do card com brief, eventos e VERDICT, a colmeia ao vivo (a partir do `colmeia.ndjson`) e "quem faz o quê". No iPhone dá para criar card (com `criado_por: fernando`, que o Chefe recebe), responder a um card bloqueado e reabrir card.
- **`/agentes`** continua sendo o controle dos panes no herdr (aprovar, negar, modo, interromper, steer), agora com só 3 panes fixos e os workers aparecendo no `/quadro`.

## 9. Migração sem perder trabalho

| Passo | O que muda | Critério de pronto |
|---|---|---|
| 1 | `packages/quadro`, as ferramentas MCP e os kits entram, sem mudar o comportamento atual. | Os testes do quadro passam: claim concorrente sem duplicar, lease vence e reconcilia. As 6 ferramentas aparecem numa sessão nova. |
| 2 | Trava de voz, TTL da fila e bench fora do `fala.lock`. | Um especialista chamando `jarvis-fala` não toca nada e gera um evento `aviso`. Uma fala esperando há mais de 60 s é descartada. O bench roda sem tocar no `fala.lock`. |
| 3 | Os panes `chefe`, `despachante` e `vigia` sobem **ao lado** do maestro e dos especialistas, com hooks do projeto. | O Chefe responde a um teste digitado com contexto do quadro. O Despachante pega um card de teste, lança um worker e conclui com VERDICT. |
| 4 | Os itens abertos de cada especialista (seções Pendências e Subagentes vivos de `~/.local/share/jarvis/maestro/agentes/<nome>/estado.md`, mais `relatorio.md`) e do maestro viram cards com `criado_por: migracao`. | Cada pendência tem um card. O Chefe revisa a lista e o Fernando vê tudo no `/quadro`. |
| 5 | A Escuta passa a mandar para o `chefe`. `voz-sempre` fica só com o id do Chefe. | Um pedido por voz chega ao Chefe, vira card e a resposta sai falada uma vez só. |
| 6 | Saem os especialistas, um por vez: `otimizacao`, `telemetria`, `escuta-voz` e, por último, `rust-core`. Cada um só sai sem subagente vivo e com os cards criados. O worktree e a branch `rust-core-poc` ficam intactos. | O herdr mostra o especialista idle, sem trabalho em curso, e os cards dele existem. O pane é fechado e o especialista sai do `agentes.json`. |
| 7 | O maestro sai: o vigia de processos passa a manter só os 3 papéis. | Uma semana sem bot falando fora do Chefe e sem card órfão depois da reconciliação. |

Um pane antigo só é fechado depois que o substituto dele estiver de pé e os itens abertos dele estiverem no quadro.

## 10. Onde fica cada coisa

| Caminho | Conteúdo |
|---|---|
| `~/.jarvis/quadro.db` | cards, eventos, mensagens |
| `~/.jarvis/colmeia.ndjson` | log visível da conversa entre bots |
| `~/.jarvis/memoria/` | `colmeia.md`, `fernando.md`, `bots/<papel>.md` |
| `~/.jarvis/locks/` | locks de recursos pesados (bench, build, modelo) |
| `packages/quadro` | biblioteca do quadro (esquema, operações, reconciliação) |
| `apps/mcp` | ferramentas `quadro_*` e `colmeia_*` no servidor ai-voice |
| `apps/claude-bots/{chefe,despachante,vigia}` | prompts e instruções de cada papel fixo |
| `.claude/agents/worker-*.md` | kits dos workers |
| `.claude/settings.json` | hooks do projeto (SessionStart, UserPromptSubmit, PreCompact) |
| `apps/dashboard` rota `/quadro` | kanban, colmeia e quem faz o quê |
| `apps/maestro` | daemon: panes fixos, tick, reconciliação, retomada, rotinas |
