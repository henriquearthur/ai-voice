import { Effect, Option, Schedule } from "effect"
import { type MaestroConfig, paths } from "./config.ts"
import { type AgentStatus, findAgent, promptAgent } from "./herdr.ts"
import { type Alvo, alvoEspecialista, alvoMaestro, lerEspecialistas, type Resultado } from "./vigia.ts"

/**
 * Prompt de retomada do papel, mandado ao agente recém-recriado: o `--resume`
 * só reabre a conversa, e o claude espera input para sempre se ninguém falar.
 * Determinístico: sai só de `agentes.json` (papel e prompt) e do sistema.md.
 */
export const promptRetomada = (alvo: Alvo): string => {
  const p = paths(alvo.dir)
  const papel = alvo.valores.PAPEL
  const prompt = alvo.valores.PROMPT
  const ehEspecialista = papel !== undefined && prompt !== undefined
  const partes = [
    `[retomada: ${alvo.nome}] Você foi recriado pelo vigia do maestro e a sessão anterior foi retomada. Retome agora o seu papel, sem esperar ninguém.`,
    ehEspecialista ? `Papel: ${papel}.` : "Papel: orquestrador (veja as regras do seu prompt de sistema).",
    ehEspecialista ? `Missão: ${prompt}` : "",
    `Releia ${p.estado} (pendências, subagentes vivos, decisões) e o seu prompt de sistema em ${p.sistema}.`,
    "Retome o que estava pendente, relance por subagentes em segundo plano o que tiver morrido com o reinício e siga o trabalho. Se não houver pendência, comece pela missão acima."
  ]
  return partes.filter((parte) => parte !== "").join("\n")
}

/** Só manda se o agente está parado esperando input: working ou blocked já têm o que fazer. */
export const deveRetomar = (status: Option.Option<AgentStatus>): boolean =>
  Option.isSome(status) && (status.value === "idle" || status.value === "done")

/** Espera o agente aparecer idle (até ~30 s) e manda o prompt de retomada; sem duplicar se já trabalha. */
export const retomarPapel = (alvo: Alvo) =>
  Effect.gen(function*() {
    const status = findAgent(alvo.nome).pipe(Effect.map(Option.map((agente) => agente.agent_status)))
    const atual = yield* status.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (s) => !Option.isSome(s) || s.value !== "unknown",
        times: 15
      })
    )
    if (!deveRetomar(atual)) return false
    yield* promptAgent(alvo.nome, promptRetomada(alvo))
    return true
  })

/** Para cada agente recriado na passada, manda a retomada do papel. Falha de um não afeta os outros. */
export const retomarRecriados = (config: MaestroConfig, resultados: ReadonlyArray<Resultado>) =>
  Effect.gen(function*() {
    const recriados = new Set(resultados.filter((r) => r._tag === "Recriado").map((r) => r.nome))
    if (recriados.size === 0) return
    const especialistas = yield* lerEspecialistas(config).pipe(Effect.orElseSucceed(() => []))
    const alvos = [alvoMaestro(config), ...especialistas.map((agente) => alvoEspecialista(config, agente))]
    for (const alvo of alvos.filter((a) => recriados.has(a.nome))) {
      const mandou = yield* retomarPapel(alvo).pipe(
        Effect.catch((error: { readonly message: string }) =>
          Effect.logWarning(`Retomada de ${alvo.nome} falhou: ${error.message}`).pipe(Effect.as(false))
        )
      )
      yield* Effect.logInfo(mandou ? `Prompt de retomada enviado a ${alvo.nome}.` : `${alvo.nome} já está ocupado; sem retomada.`)
    }
  })
