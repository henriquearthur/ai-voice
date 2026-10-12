import type { Config, RegraLixo } from "./config.ts"
import { argv0, nomeBase, type Proc } from "./ps.ts"

/** Contagem de passadas seguidas acima do limite de CPU, por pid (guardada no estado entre as passadas). */
export type CpuVisto = Readonly<Record<string, { readonly n: number; readonly idadeS: number }>>

export interface Contexto {
  readonly config: Config
  /** uid do dono: nada de outro usuário é tocado. */
  readonly uid: number
  /** pid desta passada (e, pela árvore, seus ancestrais) nunca é alvo. */
  readonly meuPid: number
  readonly cpuAnterior: CpuVisto
  /** Ambiente do processo (`ps eww`); undefined = ilegível. Só é consultado para regras com `exigeVariavel`. */
  readonly ambiente?: (pid: number) => string | undefined
}

export type TipoAlerta = "zumbi" | "cpu" | "memoria"

export interface Alvo {
  readonly proc: Proc
  readonly padrao: string
  readonly motivo: string
}

export interface Alerta {
  readonly tipo: TipoAlerta
  /** Chave de dedupe: tipo + pid + nome. */
  readonly chave: string
  readonly proc: Proc
  readonly conhecido: boolean
  readonly detalhe: string
  /** Memória de processo conhecido: nome do item (chave do estado de crescimento) e RSS que gerou o aviso. */
  readonly item?: string
  readonly rssBytes?: number
}

export interface Zumbi {
  readonly pid: number
  readonly ppid: number
  readonly comando: string
  readonly paiComando: string | undefined
  readonly idadeS: number
}

export interface Resultado {
  readonly matar: ReadonlyArray<Alvo>
  /** Casou com um padrão de lixo mas foi poupado (novo demais, pai vivo, protegido). */
  readonly poupados: ReadonlyArray<Alvo>
  readonly zumbis: ReadonlyArray<Zumbi>
  readonly alertas: ReadonlyArray<Alerta>
  readonly cpuVisto: CpuVisto
}

const casa = (r: RegExp | undefined, texto: string) => r === undefined || r.test(texto)

export const ehZumbi = (p: Proc) => p.stat.includes("Z")

const ancestrais = (p: Proc, porPid: ReadonlyMap<number, Proc>): Array<number> => {
  const vistos: Array<number> = []
  let atual: Proc | undefined = p
  while (atual && atual.ppid > 1 && !vistos.includes(atual.ppid)) {
    vistos.push(atual.ppid)
    atual = porPid.get(atual.ppid)
  }
  return vistos
}

/** Pai vivo = PPID > 1 e o pai está na tabela. PPID 1 (launchd) ou pai sumido = órfão. */
const paiVivo = (p: Proc, porPid: ReadonlyMap<number, Proc>) => p.ppid > 1 && porPid.has(p.ppid)

const casaLixo = (r: RegraLixo, p: Proc) =>
  casa(r.argv0, argv0(p.comando)) && casa(r.comando, p.comando) && !(r.excluir && r.excluir.test(p.comando))

/** Allowlist: só alerta, nunca mata. */
const itemAllowlist = (p: Proc, config: Config) =>
  config.allowlist.find((c) => casa(c.argv0, argv0(p.comando)) && casa(c.comando, p.comando))

export const naAllowlist = (p: Proc, config: Config): string | undefined => itemAllowlist(p, config)?.nome

export const fmtIdade = (s: number): string =>
  s >= 86400 ? `${(s / 86400).toFixed(1)} d` : s >= 3600 ? `${(s / 3600).toFixed(1)} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`

/**
 * Decide tudo de uma passada a partir da tabela do `ps`. Pura: não mata nem escreve nada.
 * Nunca é alvo de morte: PID abaixo de `pidMinimo`, processo de outro uid, `nuncaMatar`
 * (claude, codex, herdr), allowlist, a própria faxina e ancestrais, e qualquer ancestral de um desses.
 */
export const avaliar = (procs: ReadonlyArray<Proc>, ctx: Contexto): Resultado => {
  const { config } = ctx
  const porPid = new Map(procs.map((p) => [p.pid, p]))
  const meus = procs.filter((p) => p.uid === ctx.uid)

  // Intocáveis por nome ou allowlist, mais os ancestrais deles e o ramo da própria faxina.
  const intocaveis = new Set<number>([ctx.meuPid])
  const eu = porPid.get(ctx.meuPid)
  if (eu) for (const a of ancestrais(eu, porPid)) intocaveis.add(a)
  for (const p of meus) {
    if (config.nuncaMatar.includes(nomeBase(p.comando)) || naAllowlist(p, config)) {
      intocaveis.add(p.pid)
      for (const a of ancestrais(p, porPid)) intocaveis.add(a)
    }
  }
  const protegido = (p: Proc): string | undefined => {
    if (p.pid < config.limites.pidMinimo) return "pid abaixo do mínimo"
    if (p.uid !== ctx.uid) return "de outro usuário"
    if (config.nuncaMatar.includes(nomeBase(p.comando))) return "nunca matar"
    const nome = naAllowlist(p, config)
    if (nome) return `allowlist ${nome}`
    if (intocaveis.has(p.pid)) return "ancestral de processo protegido"
    return undefined
  }

  // 1. Zumbis
  const zumbis: Array<Zumbi> = []
  const alertas: Array<Alerta> = []
  for (const p of meus.filter(ehZumbi)) {
    const pai = porPid.get(p.ppid)
    zumbis.push({ pid: p.pid, ppid: p.ppid, comando: p.comando, paiComando: pai?.comando, idadeS: p.idadeS })
    alertas.push({
      tipo: "zumbi",
      chave: `zumbi:${p.pid}`,
      proc: p,
      conhecido: false,
      detalhe: `zumbi ${p.pid} (${nomeBase(p.comando)}) há ${fmtIdade(p.idadeS)}; pai ${p.ppid}` +
        (pai ? ` (${nomeBase(pai.comando)}) precisa dar wait ou sair` : " não existe mais")
    })
  }

  // 2. Lixo conhecido
  const matar: Array<Alvo> = []
  const poupados: Array<Alvo> = []
  for (const p of meus) {
    if (ehZumbi(p)) continue
    const regra = config.lixo.find((r) => casaLixo(r, p))
    if (!regra) continue
    const alvo = (motivo: string): Alvo => ({ proc: p, padrao: regra.padrao, motivo })
    const prot = protegido(p)
    if (prot) {
      poupados.push(alvo(`protegido: ${prot}`))
      continue
    }
    if (regra.exigeVariavel && ctx.ambiente) {
      const env = ctx.ambiente(p.pid)
      if (env !== undefined && !new RegExp(`(^|\\s)${regra.exigeVariavel}=\\S`).test(env)) {
        matar.push(alvo(`sem ${regra.exigeVariavel} próprio (usa o lock real da fala)`))
        continue
      }
    }
    if (!paiVivo(p, porPid)) {
      if (p.idadeS >= regra.idadeMinS) matar.push(alvo(`órfão há ${fmtIdade(p.idadeS)}`))
      else poupados.push(alvo(`órfão, mas só ${fmtIdade(p.idadeS)} (mínimo ${fmtIdade(regra.idadeMinS)})`))
    } else if (regra.idadeComPaiVivoS !== undefined && p.idadeS >= regra.idadeComPaiVivoS) {
      matar.push(alvo(`${fmtIdade(p.idadeS)} de idade com pai ${p.ppid} vivo`))
    } else {
      poupados.push(alvo(`pai ${p.ppid} vivo e ${fmtIdade(p.idadeS)} de idade`))
    }
  }

  // 2b. Regras com incluirFilhos: os descendentes de quem vai morrer vão junto (árvore npm/npx/node), salvo os protegidos.
  const filhosDe = new Map<number, Array<Proc>>()
  for (const p of meus) filhosDe.set(p.ppid, [...(filhosDe.get(p.ppid) ?? []), p])
  const jaMatar = new Set(matar.map((a) => a.proc.pid))
  for (const alvo of [...matar]) {
    if (!config.lixo.find((r) => r.padrao === alvo.padrao)?.incluirFilhos) continue
    const fila = [...(filhosDe.get(alvo.proc.pid) ?? [])]
    while (fila.length > 0) {
      const f = fila.shift()!
      if (jaMatar.has(f.pid) || ehZumbi(f)) continue
      if (protegido(f)) continue
      jaMatar.add(f.pid)
      matar.push({ proc: f, padrao: alvo.padrao, motivo: `filho de ${alvo.proc.pid}, que morre (${alvo.motivo})` })
      const ip = poupados.findIndex((x) => x.proc.pid === f.pid)
      if (ip >= 0) poupados.splice(ip, 1)
      fila.push(...(filhosDe.get(f.pid) ?? []))
    }
  }

  // 3. Descontrolados: só alerta, nunca mata.
  const cpuVisto: Record<string, { n: number; idadeS: number }> = {}
  for (const p of meus) {
    if (ehZumbi(p)) continue
    const conhecido = naAllowlist(p, config) !== undefined || config.nuncaMatar.includes(nomeBase(p.comando))
    const item = itemAllowlist(p, config)
    const limiteRss = item?.rssBytes ?? config.limites.rssBytes
    if (p.rssBytes > limiteRss) {
      const detalhe = `${nomeBase(p.comando)} (pid ${p.pid}) usa ${(p.rssBytes / 1024 ** 3).toFixed(1)} GB de RAM, há ${fmtIdade(p.idadeS)}`
      if (item) {
        // Conhecido: um aviso por item (o de maior RSS), chaveado pelo nome, não pelo pid.
        const i = alertas.findIndex((a) => a.tipo === "memoria" && a.item === item.nome)
        if (i < 0 || (alertas[i]!.rssBytes ?? 0) < p.rssBytes) {
          const alerta: Alerta = { tipo: "memoria", chave: `memoria:${item.nome}`, proc: p, conhecido, detalhe, item: item.nome, rssBytes: p.rssBytes }
          if (i >= 0) alertas[i] = alerta
          else alertas.push(alerta)
        }
      } else {
        alertas.push({ tipo: "memoria", chave: `memoria:${p.pid}:${nomeBase(p.comando)}`, proc: p, conhecido, detalhe })
      }
    }
    if (p.cpuPct > config.limites.cpuPct) {
      const antes = ctx.cpuAnterior[String(p.pid)]
      const n = antes && p.idadeS >= antes.idadeS ? antes.n + 1 : 1
      cpuVisto[String(p.pid)] = { n, idadeS: p.idadeS }
      if (n >= config.limites.passadasCpu) {
        alertas.push({
          tipo: "cpu",
          chave: `cpu:${p.pid}:${nomeBase(p.comando)}`,
          proc: p,
          conhecido,
          detalhe: `${nomeBase(p.comando)} (pid ${p.pid}) acima de ${config.limites.cpuPct}% de CPU por ${n} passadas (agora ${p.cpuPct}%)`
        })
      }
    }
  }
  return { matar, poupados, zumbis, alertas, cpuVisto }
}
