import { execFile, execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { PS_ARGS, parsePs, type Proc } from "./ps.ts"

export const lerPs = (): Promise<Array<Proc>> =>
  new Promise((resolve, reject) => {
    execFile("/bin/ps", [...PS_ARGS], { maxBuffer: 64 * 1024 * 1024 }, (erro, saida) =>
      erro ? reject(erro) : resolve(parsePs(saida)))
  })

const comandoDe = (pid: number): Promise<string | undefined> =>
  new Promise((resolve) => {
    execFile("/bin/ps", ["-p", String(pid), "-o", "command="], (erro, saida) =>
      resolve(erro ? undefined : saida.trim() || undefined))
  })

export type Sinal = "SIGTERM" | "SIGKILL"

/** Só sinaliza se o pid ainda é o mesmo comando visto na passada (evita reuso de pid). */
export const sinalizar = async (p: Proc, sinal: Sinal): Promise<"enviado" | "sumiu" | "trocado" | "erro"> => {
  const atual = await comandoDe(p.pid)
  if (atual === undefined) return "sumiu"
  if (atual !== p.comando) return "trocado"
  try {
    process.kill(p.pid, sinal)
    return "enviado"
  } catch {
    return "erro"
  }
}

export const aindaVivo = async (p: Proc): Promise<boolean> => (await comandoDe(p.pid)) === p.comando

const DADOS = process.env.JARVIS_DATA ?? join(homedir(), ".local", "share", "jarvis")
const PORTA = Number(process.env.JARVIS_EVENTOS_PORT ?? 7353)

/** Mesmo arquivo do maestro: ~/.local/share/jarvis/maestro/eventos-token (JARVIS_MAESTRO_DIR troca a pasta). */
export const lerToken = (): string | undefined => {
  try {
    return readFileSync(join(process.env.JARVIS_MAESTRO_DIR ?? join(DADOS, "maestro"), "eventos-token"), "utf8").trim() || undefined
  } catch {
    return undefined
  }
}

/** POST 127.0.0.1:7353/evento/<token> com {origem, texto}. Nunca lança; devolve o status ou o erro. */
export const enviarEvento = async (texto: string): Promise<string> => {
  const token = lerToken()
  if (!token) return "sem token do maestro"
  try {
    const r = await fetch(`http://127.0.0.1:${PORTA}/evento/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origem: "faxina", texto }),
      signal: AbortSignal.timeout(5000)
    })
    return `http ${r.status}`
  } catch (e) {
    return `erro: ${e instanceof Error ? e.message : String(e)}`
  }
}

/** Ambiente de um processo do mesmo usuário (`ps eww`); undefined se ilegível (binário protegido do sistema ou sumiu). */
export const lerAmbiente = (pid: number): string | undefined => {
  try {
    const saida = execFileSync("/bin/ps", ["eww", "-p", String(pid)], { encoding: "utf8", timeout: 3000 })
    const linha = saida.split("\n")[1]
    return linha && linha.includes("=") ? linha : undefined
  } catch {
    return undefined
  }
}
