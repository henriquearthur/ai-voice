import { Duration, Effect, FileSystem, Random, Schedule, Schema } from "effect"
import { Fila } from "./fila.ts"

const DIAS = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"] as const

export const Rotina = Schema.Struct({
  nome: Schema.String,
  /** "HH:MM", hora local. */
  horario: Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/)),
  /** Dias da semana; sem o campo, todo dia. */
  dias: Schema.optionalKey(Schema.Array(Schema.Literals(DIAS))),
  texto: Schema.String
})
export type Rotina = typeof Rotina.Type

export const RotinasJson = Schema.fromJsonString(Schema.Struct({ rotinas: Schema.Array(Rotina) }))

const Disparos = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))

/** Até quanto tempo depois do horário uma rotina perdida (Mac dormindo, reinício) ainda dispara. */
export const TOLERANCIA_MINUTOS = 10

const dia = (now: Date) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`

/**
 * As rotinas que devem disparar agora: o horário já passou há menos de
 * `TOLERANCIA_MINUTOS`, hoje é um dos dias e ela ainda não disparou hoje.
 */
export const devidas = (
  rotinas: ReadonlyArray<Rotina>,
  now: Date,
  disparos: Readonly<Record<string, string>>
): ReadonlyArray<Rotina> => {
  const hoje = dia(now)
  const minutos = now.getHours() * 60 + now.getMinutes()
  return rotinas.filter((rotina) => {
    const [h, m] = rotina.horario.split(":").map(Number) as [number, number]
    const atraso = minutos - (h * 60 + m)
    if (atraso < 0 || atraso >= TOLERANCIA_MINUTOS) return false
    if (rotina.dias && !rotina.dias.includes(DIAS[now.getDay()]!)) return false
    return disparos[rotina.nome] !== hoje
  })
}

/**
 * A cada 30 s relê o arquivo de rotinas (editar não exige reiniciar) e põe na
 * fila as que venceram, com a origem `rotina:<nome>`.
 */
export const agendador = (options: { readonly arquivo: string; readonly estado: string }) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const fila = yield* Fila
    const rodada = Effect.gen(function*() {
      const exists = yield* fs.exists(options.arquivo)
      if (!exists) return
      const { rotinas } = yield* fs.readFileString(options.arquivo).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(RotinasJson)),
        Effect.tapError(() => Effect.logWarning(`Arquivo de rotinas inválido: ${options.arquivo}`))
      )
      const disparos = yield* fs.readFileString(options.estado).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Disparos)),
        Effect.orElseSucceed((): Record<string, string> => ({}))
      )
      const now = new Date()
      const vencidas = devidas(rotinas, now, disparos)
      if (vencidas.length === 0) return
      const novos: Record<string, string> = { ...disparos }
      for (const rotina of vencidas) {
        yield* fila.adicionar(`rotina:${rotina.nome}`, rotina.texto)
        novos[rotina.nome] = dia(now)
      }
      const temporary = `${options.estado}.${yield* Random.nextInt}.tmp`
      yield* fs.writeFileString(temporary, JSON.stringify(novos, null, 2), { mode: 0o600 })
      yield* fs.rename(temporary, options.estado)
    })
    yield* rodada.pipe(
      Effect.catch((error) => Effect.logWarning("Rotinas adiadas", error)),
      Effect.repeat(Schedule.spaced(Duration.seconds(30)))
    )
  })
