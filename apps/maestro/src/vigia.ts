import { Effect, FileSystem, Option, Schedule, Schema } from "effect"
import { mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { type MaestroConfig, paths } from "./config.ts"
import {
  createWorkspace,
  findAgent,
  getPane,
  type HerdrError,
  type HerdrRejected,
  listPanes,
  listWorkspaces,
  splitPane,
  startClaude
} from "./herdr.ts"
import { garantirEstado, gravar, lerModelo, renderizar } from "./memoria.ts"

/** Raiz do repositório (apps/maestro/src → ../../..). */
export const REPO = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "")

const Sessao = Schema.fromJsonString(Schema.Struct({
  session_id: Schema.String,
  transcript_path: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String)
}))

export interface SessaoSalva {
  readonly id: string
  /** Onde a sessão rodou: o --resume só acha a conversa no mesmo diretório. */
  readonly cwd: string | undefined
}

const PaneSalvo = Schema.fromJsonString(Schema.Struct({ pane_id: Schema.String }))

export type Resultado =
  | { readonly _tag: "Vivo"; readonly nome: string; readonly pane: string }
  | { readonly _tag: "Recriado"; readonly nome: string; readonly pane: string; readonly retomou: Option.Option<string> }
  | { readonly _tag: "Falhou"; readonly nome: string; readonly erro: string }

/** Argumentos do claude: a regra de delegação, a fala liberada e, se houver, a sessão a retomar. */
export const argsClaude = (options: {
  readonly sistema: string
  readonly fala: string
  readonly settings: string
  readonly resume: Option.Option<string>
  /** Modelo do claude (`--model`); sem ele vale o padrão. */
  readonly model?: string | undefined
  readonly addDirs?: ReadonlyArray<string>
}): ReadonlyArray<string> => [
  ...(Option.isSome(options.resume) ? ["--resume", options.resume.value] : []),
  ...(options.model ? ["--model", options.model] : []),
  "--append-system-prompt-file",
  options.sistema,
  "--allowedTools",
  `Bash(${options.fala}:*)`,
  ...(options.settings !== "" ? ["--settings", options.settings] : []),
  ...(options.addDirs ?? []).flatMap((dir) => ["--add-dir", dir])
]

/** A última sessão, se o transcript ainda existir (sem ele o --resume falharia). */
export const sessaoSalva = (dir: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const sessao = yield* fs.readFileString(paths(dir).sessao).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Sessao)),
      Effect.option
    )
    if (Option.isNone(sessao)) return Option.none<SessaoSalva>()
    const { session_id, transcript_path, cwd } = sessao.value
    const salva: SessaoSalva = { id: session_id, cwd }
    const transcript = transcript_path ?? ""
    const existe = transcript !== "" && (yield* fs.exists(transcript).pipe(Effect.orElseSucceed(() => false)))
    if (existe) return Option.some(salva)
    // Sem caminho salvo, procura o transcript em qualquer projeto do Claude Code.
    const glob = new Bun.Glob(`*/${session_id}.jsonl`)
    const achou = yield* Effect.promise(async () => {
      for await (const _ of glob.scan({ cwd: join(homedir(), ".claude", "projects"), onlyFiles: true })) return true
      return false
    }).pipe(Effect.orElseSucceed(() => false))
    return achou ? Option.some(salva) : Option.none<SessaoSalva>()
  })

/**
 * Os hooks de memória (SessionStart e PreCompact) num settings só dos agentes
 * do vigia, passado com --settings: funciona sem mexer no ~/.claude/settings.json.
 */
export const hooksSettings = (bun: string) => {
  const hook = (script: string, timeout: number) => ({
    type: "command",
    command: `${bun} ${REPO}/apps/maestro/src/hooks/${script}`,
    timeout
  })
  return {
    hooks: {
      SessionStart: [{ matcher: "startup|resume|compact|clear", hooks: [hook("session-start.ts", 10)] }],
      PreCompact: [{ hooks: [hook("pre-compact.ts", 30)] }]
    }
  }
}

const garantirHooks = (config: MaestroConfig) =>
  Effect.sync(() => {
    if (config.settings !== "") return config
    const arquivo = join(config.dir, "hooks.json")
    mkdirSync(config.dir, { recursive: true, mode: 0o700 })
    gravar(arquivo, JSON.stringify(hooksSettings(process.execPath), null, 2) + "\n")
    return { ...config, settings: arquivo }
  })

/** Um especialista de `agentes.json`: nome no herdr, papel e prompt próprio. */
export const Especialista = Schema.Struct({
  nome: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,31}$/)),
  papel: Schema.String,
  prompt: Schema.String,
  /** Modelo opcional do claude (`--model`, ex.: "sonnet"); sem ele fica o padrão. */
  model: Schema.optionalKey(Schema.String),
  /** Último pane usado; o vigia atualiza. */
  pane: Schema.optionalKey(Schema.String)
})
export type Especialista = typeof Especialista.Type

export const AgentesJson = Schema.fromJsonString(Schema.Struct({ agentes: Schema.Array(Especialista) }))

/** Tudo que o vigia precisa saber de um agente para recriá-lo. */
export interface Alvo {
  readonly nome: string
  /** Pasta própria: casa/, sistema.md, sessao.json, pane.json, estado.md. */
  readonly dir: string
  readonly modeloSistema: string
  readonly modeloClaude: string
  readonly valores: Readonly<Record<string, string>>
  readonly addDirs: ReadonlyArray<string>
  readonly model?: string | undefined
}

export const alvoMaestro = (config: MaestroConfig): Alvo => ({
  nome: config.name,
  dir: config.dir,
  modeloSistema: "sistema.md.in",
  modeloClaude: "CLAUDE.md.in",
  valores: { NOME: config.name, FALA: config.fala, ESTADO: paths(config.dir).estado },
  addDirs: []
})

export const alvoEspecialista = (config: MaestroConfig, agente: Especialista): Alvo => {
  const dir = paths(config.dir).especialista(agente.nome)
  return {
    nome: agente.nome,
    dir,
    modeloSistema: "especialista-sistema.md.in",
    modeloClaude: "especialista-CLAUDE.md.in",
    valores: {
      NOME: agente.nome,
      PAPEL: agente.papel,
      PROMPT: agente.prompt,
      FALA: config.fala,
      ESTADO: paths(dir).estado,
      REPO,
      MAESTRO: config.name
    },
    addDirs: [REPO],
    model: agente.model
  }
}

/** Escreve CLAUDE.md da casa, o prompt de sistema e o estado.md inicial a partir dos modelos. */
export const prepararCasa = (alvo: Alvo) =>
  Effect.sync(() => {
    const p = paths(alvo.dir)
    garantirEstado(alvo.dir, alvo.nome)
    mkdirSync(p.casa, { recursive: true, mode: 0o700 })
    gravar(join(p.casa, "CLAUDE.md"), renderizar(lerModelo(alvo.modeloClaude), alvo.valores))
    gravar(p.sistema, renderizar(lerModelo(alvo.modeloSistema), alvo.valores))
  })

/** Lê os especialistas; sem arquivo, nenhum. Um arquivo inválido falha alto (o log mostra). */
export const lerEspecialistas = (config: MaestroConfig) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const arquivo = paths(config.dir).agentes
    if (!(yield* fs.exists(arquivo))) return [] as ReadonlyArray<Especialista>
    const { agentes } = yield* fs.readFileString(arquivo).pipe(Effect.flatMap(Schema.decodeUnknownEffect(AgentesJson)))
    return agentes
  })

/** Guarda o pane no `pane.json` do agente e, para especialista, também no `agentes.json`. */
const salvarPane = (config: MaestroConfig, alvo: Alvo, pane: string) =>
  Effect.sync(() => {
    gravar(paths(alvo.dir).pane, JSON.stringify({ pane_id: pane }) + "\n")
    if (alvo.dir === config.dir) return
    const arquivo = paths(config.dir).agentes
    try {
      const atual = JSON.parse(readFileSync(arquivo, "utf8")) as { agentes: Array<{ nome: string; pane?: string }> }
      for (const agente of atual.agentes) if (agente.nome === alvo.nome) agente.pane = pane
      gravar(arquivo, JSON.stringify(atual, null, 2) + "\n")
    } catch {
      // O pane.json do agente já guarda o pane; o espelho no agentes.json é só conveniência.
    }
  })

/** Onde abrir um pane novo: ao lado de `ancora` (ou do primeiro pane do workspace); sem workspace, cria um. */
export interface Ancora {
  readonly pane: string
  readonly direction: "right" | "down"
}

/**
 * Um pane para o agente: o último usado, se ainda existir sem agente; senão um
 * pane novo junto da âncora, no workspace `config.workspace` (rótulo ou id).
 */
const paneLivre = (config: MaestroConfig, alvo: Alvo, cwd: string, ancora: Option.Option<Ancora>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const salvo = yield* fs.readFileString(paths(alvo.dir).pane).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PaneSalvo)),
      Effect.option
    )
    if (Option.isSome(salvo)) {
      const pane = yield* getPane(salvo.value.pane_id)
      if (Option.isSome(pane) && pane.value.agent === undefined) return pane.value.pane_id
    }
    const env = { JARVIS_MAESTRO_DIR: alvo.dir, JARVIS_MAESTRO_NOME: alvo.nome }
    let pane: string
    if (Option.isSome(ancora)) {
      pane = yield* splitPane({ pane: ancora.value.pane, direction: ancora.value.direction, cwd, env })
    } else {
      const workspace = (yield* listWorkspaces).find((w) =>
        w.label === config.workspace || w.workspace_id === config.workspace
      )
      const vizinho = workspace ? (yield* listPanes(workspace.workspace_id))[0] : undefined
      pane = vizinho
        ? yield* splitPane({ pane: vizinho.pane_id, cwd, env })
        : yield* createWorkspace({ cwd, label: config.workspace, env })
    }
    yield* salvarPane(config, alvo, pane)
    return pane
  })

/**
 * Garante um agente: se `alvo.nome` sumiu do herdr, recria o pane e inicia o
 * claude retomando a sessão salva. Se a retomada falhar, começa uma sessão
 * nova no mesmo pane; o estado.md volta pelo hook.
 */
export const garantir = (config: MaestroConfig, alvo: Alvo, ancora: Option.Option<Ancora>) =>
  Effect.gen(function*() {
    const vivo = yield* findAgent(alvo.nome)
    if (Option.isSome(vivo)) {
      return { _tag: "Vivo", nome: alvo.nome, pane: vivo.value.pane_id } satisfies Resultado as Resultado
    }

    yield* prepararCasa(alvo)
    const salva = yield* sessaoSalva(alvo.dir)
    const resume = Option.map(salva, (sessao) => sessao.id)
    const cwd = Option.getOrUndefined(salva)?.cwd ?? paths(alvo.dir).casa
    const pane = yield* paneLivre(config, alvo, cwd, ancora)
    const base = { sistema: paths(alvo.dir).sistema, fala: config.fala, settings: config.settings, addDirs: alvo.addDirs, model: alvo.model }
    // Um pane recém-aberto leva alguns segundos até o shell mostrar o prompt.
    const iniciar = (resume: Option.Option<string>) =>
      startClaude({ name: alvo.nome, pane, args: argsClaude({ ...base, resume }) }).pipe(
        Effect.retry({
          while: (error) => error._tag === "HerdrRejected" && /available shell/.test(error.message),
          schedule: Schedule.spaced("1 second"),
          times: 20
        }),
        // Bloqueado num diálogo de início (aviso de limite, confiança): o claude subiu e o pane é dele.
        Effect.catchIf(
          (error) => error._tag === "HerdrRejected" && error.code === "agent_not_ready",
          (error) => Effect.logWarning(`${alvo.nome} subiu bloqueado num diálogo: ${error.message}`)
        )
      )

    const retomou = yield* iniciar(resume).pipe(
      Effect.as(resume),
      Effect.catch((error: HerdrError | HerdrRejected) => {
        if (Option.isNone(resume)) return Effect.fail(error)
        return Effect.logWarning(`Não retomei a sessão ${resume.value} de ${alvo.nome} (${error.message}); começo uma nova.`).pipe(
          Effect.andThen(Effect.sleep("2 seconds")),
          Effect.andThen(findAgent(alvo.nome)),
          // O claude pode ter subido mesmo com o start reclamando (por exemplo, bloqueado num diálogo).
          Effect.flatMap((agora) =>
            Option.isSome(agora) ? Effect.succeed(resume) : iniciar(Option.none()).pipe(Effect.as(Option.none<string>()))
          )
        )
      })
    )
    return { _tag: "Recriado", nome: alvo.nome, pane, retomou } satisfies Resultado as Resultado
  })

/**
 * Uma passada do vigia sobre todos: primeiro o maestro, depois cada
 * especialista de `agentes.json`. Os especialistas formam uma coluna: o
 * primeiro abre à direita do maestro, os seguintes abaixo do anterior. A falha
 * de um não impede os outros.
 */
export const vigiar = (configBase: MaestroConfig) =>
  Effect.gen(function*() {
    const config = yield* garantirHooks(configBase)
    const resultados: Array<Resultado> = []
    const falhou = (nome: string) => (error: { readonly message: string }) =>
      Effect.succeed({ _tag: "Falhou", nome, erro: error.message } satisfies Resultado as Resultado)

    const maestro = yield* garantir(config, alvoMaestro(config), Option.none()).pipe(Effect.catch(falhou(config.name)))
    resultados.push(maestro)

    const especialistas = yield* lerEspecialistas(config).pipe(
      Effect.tapError((error) => Effect.logWarning(`agentes.json inválido: ${error.message}`)),
      Effect.orElseSucceed((): ReadonlyArray<Especialista> => [])
    )
    let ancora: Option.Option<Ancora> = maestro._tag === "Falhou"
      ? Option.none()
      : Option.some({ pane: maestro.pane, direction: "right" })
    for (const agente of especialistas) {
      const resultado = yield* garantir(config, alvoEspecialista(config, agente), ancora).pipe(
        Effect.catch(falhou(agente.nome))
      )
      resultados.push(resultado)
      if (resultado._tag !== "Falhou") ancora = Option.some({ pane: resultado.pane, direction: "down" })
    }
    return resultados
  })
