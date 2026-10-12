import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { join, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { DEFAULT_DIR, paths } from "./config.ts"

/**
 * Memória do maestro em `<dir>/estado.md`, usada pelos hooks (sem Effect, para
 * abrir rápido a cada sessão) e pelo vigia.
 */

export const AUTO_INICIO = "<!-- auto:inicio (gravado pelo hook PreCompact; não edite) -->"
export const AUTO_FIM = "<!-- auto:fim -->"

const AGENTE_DIR = fileURLToPath(new URL("../agente/", import.meta.url))

export const maestroDir = (env: Readonly<Record<string, string | undefined>> = process.env) =>
  env.JARVIS_MAESTRO_DIR && env.JARVIS_MAESTRO_DIR !== "" ? env.JARVIS_MAESTRO_DIR : DEFAULT_DIR

const real = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Se a sessão roda na casa do maestro: só ela é tocada pelos hooks, mesmo com eles no settings global. */
export const ehMaestro = (cwd: string | undefined, dir: string) => {
  if (!cwd) return false
  const casa = real(paths(dir).casa)
  const atual = real(cwd)
  return atual === casa || atual.startsWith(casa + sep)
}

/** O nome que o herdr dá ao agente do pane `paneId`, se der algum (até 3 s). */
const nomeNoHerdr = (paneId: string, env: Readonly<Record<string, string | undefined>>) => {
  const herdr = env.JARVIS_HERDR || join(homedir(), ".local", "bin", "herdr")
  try {
    const saida = spawnSync(herdr, ["agent", "get", paneId], { encoding: "utf8", timeout: 3_000 })
    return JSON.parse(saida.stdout)?.result?.agent?.name as string | undefined
  } catch {
    return undefined
  }
}

/**
 * Se esta sessão é a do maestro: roda na casa dele, num pane que o vigia
 * criou (com `JARVIS_MAESTRO_NOME` no ambiente) ou num pane que o herdr chama
 * pelo nome do maestro. Qualquer outra sessão é ignorada pelos hooks.
 */
export const ehSessaoDoMaestro = (
  cwd: string | undefined,
  dir: string,
  nome: string,
  env: Readonly<Record<string, string | undefined>> = process.env
) => {
  if (ehMaestro(cwd, dir)) return true
  if (env.JARVIS_MAESTRO_NOME === nome) return true
  return env.HERDR_PANE_ID ? nomeNoHerdr(env.HERDR_PANE_ID, env) === nome : false
}

/** Troca os marcadores `@CHAVE@` de um modelo de `agente/`. */
export const renderizar = (modelo: string, valores: Readonly<Record<string, string>>) =>
  Object.entries(valores).reduce((texto, [k, v]) => texto.replaceAll(`@${k}@`, v), modelo)

export const lerModelo = (nome: string) => readFileSync(join(AGENTE_DIR, nome), "utf8")

/** Escrita atômica e privada. Devolve se o conteúdo mudou. */
export const gravar = (file: string, contents: string) => {
  if (existsSync(file) && readFileSync(file, "utf8") === contents) return false
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, contents, { mode: 0o600 })
  renameSync(temporary, file)
  return true
}

/** Cria a pasta e um estado.md vazio, se faltarem. */
export const garantirEstado = (dir: string, nome: string) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const { estado } = paths(dir)
  if (!existsSync(estado)) gravar(estado, renderizar(lerModelo("estado.md.in"), { NOME: nome }))
  return estado
}

/** Põe `bloco` entre os marcadores automáticos, substituindo o anterior ou anexando no fim. */
export const atualizarAuto = (conteudo: string, bloco: string) => {
  const novo = `${AUTO_INICIO}\n${bloco.trim()}\n${AUTO_FIM}`
  const inicio = conteudo.indexOf(AUTO_INICIO)
  const fim = conteudo.indexOf(AUTO_FIM)
  if (inicio !== -1 && fim > inicio) return conteudo.slice(0, inicio) + novo + conteudo.slice(fim + AUTO_FIM.length)
  return `${conteudo.trimEnd()}\n\n${novo}\n`
}

export interface Resumo {
  readonly pedidos: ReadonlyArray<string>
  readonly subagentes: ReadonlyArray<string>
  readonly ultimaResposta: string | undefined
}

const curto = (texto: string, max: number) => {
  const linha = texto.replace(/\s+/g, " ").trim()
  return linha.length > max ? `${linha.slice(0, max - 1)}…` : linha
}

type Parte = { type?: string; text?: string; name?: string; input?: { description?: string; prompt?: string } }

const partes = (content: unknown): ReadonlyArray<Parte> =>
  typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content as Array<Parte> : []

/**
 * Lê o transcript JSONL do Claude Code e tira o que ajuda a retomar: os
 * últimos pedidos, os últimos subagentes lançados e a última resposta.
 */
export const resumirTranscript = (jsonl: string): Resumo => {
  const pedidos: Array<string> = []
  const subagentes: Array<string> = []
  let ultimaResposta: string | undefined
  for (const linha of jsonl.split("\n")) {
    if (linha.trim() === "") continue
    let entrada: { type?: string; isMeta?: boolean; message?: { content?: unknown } }
    try {
      entrada = JSON.parse(linha)
    } catch {
      continue
    }
    if (entrada.isMeta) continue
    for (const parte of partes(entrada.message?.content)) {
      if (entrada.type === "user" && parte.type === "text" && parte.text && !parte.text.trimStart().startsWith("<")) {
        pedidos.push(curto(parte.text, 300))
      }
      if (entrada.type === "assistant" && parte.type === "text" && parte.text?.trim()) {
        ultimaResposta = curto(parte.text, 500)
      }
      if (entrada.type === "assistant" && parte.type === "tool_use" && (parte.name === "Agent" || parte.name === "Task")) {
        subagentes.push(curto(parte.input?.description ?? parte.input?.prompt ?? "(sem descrição)", 120))
      }
    }
  }
  return { pedidos: pedidos.slice(-5), subagentes: subagentes.slice(-10), ultimaResposta }
}

export const blocoAuto = (info: {
  readonly quando: Date
  readonly sessao: string
  readonly gatilho: string
  readonly resumo: Resumo
}) => {
  const lista = (itens: ReadonlyArray<string>) => itens.length === 0 ? "- (nenhum)" : itens.map((i) => `- ${i}`).join("\n")
  return [
    `## Retrato antes da compactação`,
    ``,
    `${info.quando.toISOString()} · sessão ${info.sessao} · gatilho ${info.gatilho}`,
    ``,
    `### Últimos pedidos`,
    lista(info.resumo.pedidos),
    ``,
    `### Subagentes lançados nesta sessão (confira em "Subagentes vivos" quais seguem rodando)`,
    lista(info.resumo.subagentes),
    ``,
    `### Última resposta`,
    info.resumo.ultimaResposta ?? "(nenhuma)"
  ].join("\n")
}
