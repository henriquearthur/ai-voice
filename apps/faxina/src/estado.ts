import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { CpuVisto, TipoAlerta, Zumbi } from "./regras.ts"

export interface Estado {
  atualizado_em: string
  passadas: number
  zumbis: Array<Zumbi>
  /** Passadas seguidas acima do limite de CPU, por pid. */
  cpu: CpuVisto
  /** Último envio ao maestro por chave de alerta (ms), para o dedupe. */
  alertas: Record<string, number>
  /** Último RSS (bytes) avisado por item conhecido, chaveado pelo nome do item (sobrevive à troca de PID). */
  memoria: Record<string, number>
  totais: {
    mortos: Record<string, number>
    alertas: Record<string, number>
  }
  ultima: {
    mortos: Array<{ pid: number; padrao: string; motivo: string; comando: string }>
    poupados: Array<{ pid: number; padrao: string; motivo: string }>
    alertas: Array<{ tipo: TipoAlerta; detalhe: string; novo: boolean }>
  }
}

export const estadoVazio = (): Estado => ({
  atualizado_em: "",
  passadas: 0,
  zumbis: [],
  cpu: {},
  alertas: {},
  memoria: {},
  totais: { mortos: {}, alertas: {} },
  ultima: { mortos: [], poupados: [], alertas: [] }
})

export const lerEstado = (caminho: string): Estado => {
  try {
    return { ...estadoVazio(), ...JSON.parse(readFileSync(caminho, "utf8")) }
  } catch {
    return estadoVazio()
  }
}

/** Grava por arquivo temporário + rename, para quem lê nunca ver meio arquivo. */
export const gravarEstado = (caminho: string, estado: Estado): void => {
  mkdirSync(dirname(caminho), { recursive: true })
  const tmp = `${caminho}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(estado, null, 2) + "\n")
  renameSync(tmp, caminho)
}

/** Uma linha JSON por ação em acoes.jsonl. */
export const registrarAcao = (pasta: string, acao: Record<string, unknown>): void => {
  mkdirSync(pasta, { recursive: true })
  appendFileSync(join(pasta, "acoes.jsonl"), JSON.stringify({ em: new Date().toISOString(), ...acao }) + "\n")
}

/** Alerta novo = nunca enviado ou enviado há mais de `dedupeMin`. Também poda chaves velhas. */
export const filtrarNovos = <A extends { readonly chave: string }>(
  alertas: ReadonlyArray<A>,
  enviados: Record<string, number>,
  agora: number,
  dedupeMin: number
): { novos: Array<A>; enviados: Record<string, number> } => {
  const janela = dedupeMin * 60_000
  const saida: Record<string, number> = {}
  for (const [k, t] of Object.entries(enviados)) if (agora - t < janela * 4) saida[k] = t
  const novos: Array<A> = []
  for (const a of alertas) {
    const ultimo = saida[a.chave]
    if (ultimo === undefined || agora - ultimo >= janela) {
      novos.push(a)
      saida[a.chave] = agora
    }
  }
  return { novos, enviados: saida }
}

/**
 * Memória de item conhecido: avisa na primeira vez acima do limite e depois só se o RSS
 * cresceu `fator` (0,25 = 25%) ou mais sobre o último aviso. Chave = nome do item, não o pid.
 * Item que saiu da lista (voltou abaixo do limite) é esquecido, e o próximo estouro avisa de novo.
 */
export const filtrarCrescimento = <A extends { readonly item: string; readonly rssBytes: number }>(
  alertas: ReadonlyArray<A>,
  ultimos: Record<string, number>,
  fator: number
): { novos: Array<A>; memoria: Record<string, number> } => {
  const memoria: Record<string, number> = {}
  const novos: Array<A> = []
  for (const a of alertas) {
    const antes = ultimos[a.item]
    if (antes === undefined || a.rssBytes >= antes * (1 + fator)) {
      novos.push(a)
      memoria[a.item] = a.rssBytes
    } else memoria[a.item] = antes
  }
  return { novos, memoria }
}
