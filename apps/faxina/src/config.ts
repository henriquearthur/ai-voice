import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export interface Limites {
  readonly pidMinimo: number
  readonly cpuPct: number
  readonly passadasCpu: number
  readonly rssBytes: number
  readonly esperaSigkillS: number
  readonly dedupeMin: number
  /** Processo conhecido acima do limite só avisa de novo se crescer esta fração (0,25 = 25%) desde o último aviso do item. */
  readonly crescimentoMemoria: number
}

export interface Casador {
  readonly nome: string
  /** Regex sobre o executável (primeiro token). */
  readonly argv0?: RegExp
  /** Regex sobre a linha de comando inteira. */
  readonly comando?: RegExp
  /** Limite de RAM (bytes) próprio deste item; ausente = `limites.rssBytes`. */
  readonly rssBytes?: number
}

export interface RegraLixo {
  readonly padrao: string
  readonly argv0?: RegExp
  readonly comando?: RegExp
  readonly excluir?: RegExp
  /** Idade mínima (s) para matar quando o processo é órfão (PPID 1 ou pai morto). */
  readonly idadeMinS: number
  /** Com o pai vivo, só mata a partir desta idade (s). Ausente = nunca com pai vivo. */
  readonly idadeComPaiVivoS?: number
  /** Variável de ambiente que o processo precisa ter; sem ela morre na hora, sem olhar idade nem pai. */
  readonly exigeVariavel?: string
  /** Ao matar um alvo desta regra, mata também os descendentes dele (npm/npx/node da mesma árvore), exceto os protegidos. */
  readonly incluirFilhos?: boolean
}

export interface Config {
  readonly limites: Limites
  readonly nuncaMatar: ReadonlyArray<string>
  readonly allowlist: ReadonlyArray<Casador>
  readonly lixo: ReadonlyArray<RegraLixo>
}

interface BrutoCasador { nome?: string; padrao?: string; argv0?: string; comando?: string; excluir?: string; rssBytes?: number }

const re = (fonte: string | undefined, onde: string): RegExp | undefined => {
  if (fonte === undefined) return undefined
  try {
    return new RegExp(fonte)
  } catch (e) {
    throw new Error(`regex inválida em ${onde}: ${fonte} (${String(e)})`)
  }
}

/** Valida e compila o JSON da config. Uma regra sem argv0 nem comando é recusada: lixo só por lista explícita. */
export const compilarConfig = (bruto: any): Config => {
  const l = bruto.limites ?? {}
  const num = (k: string, d: number) => (typeof l[k] === "number" ? l[k] : d)
  const limites: Limites = {
    pidMinimo: Math.max(100, num("pidMinimo", 100)),
    cpuPct: num("cpuPct", 15),
    passadasCpu: num("passadasCpu", 5),
    rssBytes: num("rssBytes", 1.5 * 1024 ** 3),
    esperaSigkillS: num("esperaSigkillS", 5),
    dedupeMin: num("dedupeMin", 30),
    crescimentoMemoria: num("crescimentoMemoria", 0.25)
  }
  const allowlist = ((bruto.allowlist ?? []) as Array<BrutoCasador>).map((c, i): Casador => {
    const a = re(c.argv0, `allowlist[${i}].argv0`)
    const k = re(c.comando, `allowlist[${i}].comando`)
    if (!a && !k) throw new Error(`allowlist[${i}] sem argv0 nem comando`)
    return { nome: c.nome ?? `allow-${i}`, ...(a ? { argv0: a } : {}), ...(k ? { comando: k } : {}), ...(typeof c.rssBytes === "number" ? { rssBytes: c.rssBytes } : {}) }
  })
  const lixo = ((bruto.lixo ?? []) as Array<BrutoCasador & { idadeMinS?: number; idadeComPaiVivoS?: number; exigeVariavel?: string; incluirFilhos?: boolean }>).map(
    (r, i): RegraLixo => {
      const a = re(r.argv0, `lixo[${i}].argv0`)
      const k = re(r.comando, `lixo[${i}].comando`)
      const x = re(r.excluir, `lixo[${i}].excluir`)
      if (!r.padrao) throw new Error(`lixo[${i}] sem padrao`)
      if (!a && !k) throw new Error(`lixo[${i}] (${r.padrao}) sem argv0 nem comando`)
      return {
        padrao: r.padrao,
        ...(a ? { argv0: a } : {}),
        ...(k ? { comando: k } : {}),
        ...(x ? { excluir: x } : {}),
        ...(r.exigeVariavel ? { exigeVariavel: r.exigeVariavel } : {}),
        ...(r.incluirFilhos ? { incluirFilhos: true } : {}),
        idadeMinS: r.idadeMinS ?? 600,
        ...(r.idadeComPaiVivoS === undefined ? {} : { idadeComPaiVivoS: r.idadeComPaiVivoS })
      }
    }
  )
  const nuncaMatar = [...new Set<string>(["claude", "codex", "herdr", ...((bruto.nuncaMatar ?? []) as Array<string>)])]
  return { limites, nuncaMatar, allowlist, lixo }
}

export const DADOS = process.env.JARVIS_DATA ?? join(homedir(), ".local", "share", "jarvis")
export const PASTA = join(DADOS, "faxina")
export const CONFIG_PADRAO = fileURLToPath(new URL("../faxina.config.json", import.meta.url))

export const lerConfig = (caminho: string = process.env.JARVIS_FAXINA_CONFIG ?? CONFIG_PADRAO): Config =>
  compilarConfig(JSON.parse(readFileSync(caminho, "utf8")))
