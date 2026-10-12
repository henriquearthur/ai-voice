import { Effect, Metric } from "effect"

/** Contadores terminam em `_total`. Como cada passada é um processo novo, o valor enviado é o total acumulado do estado.json. */
export const mortos = Metric.counter("jarvis_faxina_mortos_total", {
  description: "Processos de lixo conhecido encerrados pela faxina, por padrão.",
  incremental: true
})
export const alertas = Metric.counter("jarvis_faxina_alertas_total", {
  description: "Alertas novos da faxina (zumbi, cpu, memoria), já com dedupe de 30 min.",
  incremental: true
})
export const zumbisGauge = Metric.gauge("jarvis_faxina_zumbis", { description: "Zumbis (estado Z) vistos na última passada." })

export const publicar = (totais: { mortos: Record<string, number>; alertas: Record<string, number> }, zumbis: number) =>
  Effect.all([
    ...Object.entries(totais.mortos).map(([padrao, n]) => Metric.update(Metric.withAttributes(mortos, { padrao }), n)),
    ...Object.entries(totais.alertas).map(([tipo, n]) => Metric.update(Metric.withAttributes(alertas, { tipo }), n)),
    Metric.update(zumbisGauge, zumbis)
  ], { discard: true })
