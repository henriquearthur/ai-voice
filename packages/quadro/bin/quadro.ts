#!/usr/bin/env bun
import {
  concluirCard, criarCard, enviarMensagem, listarCards, mensagens, pegarCard, reconciliar, resumo,
  exportarEventosJson, type Estado, type Kit, type Verdict
} from "../src/index.ts"

const [cmd, ...args] = process.argv.slice(2)
const flags: Record<string, string> = {}
const pos: string[] = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]!
  if (a.startsWith("--")) flags[a.slice(2)] = args[++i] ?? ""
  else pos.push(a)
}
const falha = (m: string): never => { console.error(m); process.exit(1) }
const linha = (c: { id: string; estado: string; kit: string; titulo: string; dono: string | null }) =>
  `${c.id}\t${c.estado}\t${c.kit}\t${c.dono ?? "-"}\t${c.titulo}`

switch (cmd) {
  case "resumo": console.log(resumo()); break
  case "listar": {
    const cards = listarCards({
      estado: flags.estado as Estado | undefined, dono: flags.dono,
      limite: flags.limite ? Number(flags.limite) : undefined
    })
    console.log(cards.length ? cards.map(linha).join("\n") : "(vazio)")
    break
  }
  case "criar": {
    const titulo = flags.titulo ?? pos[0]
    if (!titulo) falha("uso: quadro criar --titulo T [--brief B] [--kit geral] [--por quem] [--prioridade n]")
    const c = criarCard({
      titulo: titulo!, brief: flags.brief ?? "", kit: (flags.kit ?? "geral") as Kit,
      criado_por: flags.por ?? process.env.USER ?? "cli", prioridade: flags.prioridade ? Number(flags.prioridade) : 0
    })
    console.log(c.id)
    break
  }
  case "pegar": {
    const dono = flags.dono ?? pos[1]
    if (!dono) falha("uso: quadro pegar <id|proximo> --dono D [--lease min]")
    const c = pegarCard(pos[0] ?? "proximo", dono!, flags.lease ? Number(flags.lease) : 15)
    if (!c) { console.log("nada para pegar"); process.exit(2) }
    console.log(`${c!.id}\t${c!.titulo}\n${c!.brief}`)
    break
  }
  case "concluir": {
    const id = pos[0]
    if (!id || !flags.dono || !flags.verdict) falha("uso: quadro concluir <id> --dono D --verdict PASS|ISSUES|BLOCKED [--resultado R]")
    try {
      const c = concluirCard(id!, flags.dono!, { verdict: flags.verdict as Verdict, resultado: flags.resultado ?? "" })
      console.log(`${c.id} -> ${c.estado}`)
    } catch (e) { falha((e as Error).message) }
    break
  }
  case "reconciliar": console.log(`${reconciliar()} card(s) devolvido(s)`); break
  case "msg": {
    if (pos.length === 0) {
      const ms = mensagens({ limite: flags.limite ? Number(flags.limite) : 20 })
      console.log(ms.length ? ms.map((m) => `${m.id}\t${m.de}→${m.para}\t${m.texto}`).join("\n") : "(sem mensagens)")
    } else {
      const [de, para, ...t] = pos
      if (!de || !para || !t.length) falha("uso: quadro msg [de para texto...]")
      enviarMensagem(de!, para!, t.join(" "))
      console.log("ok")
    }
    break
  }
  case "eventos": console.log(exportarEventosJson(pos[0])); break
  default:
    falha("subcomandos: resumo | listar | criar | pegar | concluir | reconciliar | msg | eventos")
}
