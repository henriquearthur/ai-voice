import { Context, Effect, FileSystem, Layer, Random, Ref, Schema, Semaphore } from "effect"

export const MAX_ORIGEM = 60
export const MAX_TEXTO = 8_000
export const MAX_PENDENTES = 200

export const Evento = Schema.Struct({
  id: Schema.String,
  origem: Schema.String,
  texto: Schema.String,
  recebido: Schema.String
})
export type Evento = typeof Evento.Type

const FilaJson = Schema.fromJsonString(Schema.Struct({ version: Schema.Literal(1), eventos: Schema.Array(Evento) }))

/** A origem vira uma etiqueta curta e de uma linha, sem colchetes que confundam o marcador. */
export const limparOrigem = (origem: string) =>
  origem.replace(/[\[\]\r\n\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_ORIGEM) || "desconhecida"

/**
 * Junta os eventos numa mensagem só, um bloco por evento, cada um com o
 * marcador `[evento: origem]`.
 */
export const formatarEntrega = (eventos: ReadonlyArray<Evento>) =>
  eventos.map((evento) => `[evento: ${evento.origem}] ${evento.texto.trim()}`).join("\n\n")

export interface FilaApi {
  readonly adicionar: (origem: string, texto: string) => Effect.Effect<Evento>
  readonly pendentes: Effect.Effect<ReadonlyArray<Evento>>
  /** Tira da fila os eventos entregues. */
  readonly remover: (ids: ReadonlyArray<string>) => Effect.Effect<void>
}

/**
 * Fila persistida em JSON: sobrevive a um reinício do LaunchAgent. Um arquivo
 * ilegível começa vazio em vez de derrubar o serviço.
 */
export class Fila extends Context.Service<Fila, FilaApi>()("@jarvis/maestro/Fila") {
  static readonly layer = (file: string) =>
    Layer.effect(
      Fila,
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const inicial = yield* fs.readFileString(file).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(FilaJson)),
          Effect.map((fila) => fila.eventos),
          Effect.orElseSucceed((): ReadonlyArray<Evento> => [])
        )
        const estado = yield* Ref.make(inicial)
        const lock = yield* Semaphore.make(1)

        const salvar = (eventos: ReadonlyArray<Evento>) =>
          Effect.gen(function*() {
            const temporary = `${file}.${yield* Random.nextInt}.tmp`
            const contents = yield* Schema.encodeEffect(FilaJson)({ version: 1, eventos })
            yield* fs.writeFileString(temporary, contents, { mode: 0o600 })
            yield* fs.rename(temporary, file)
          }).pipe(Effect.catch((error) => Effect.logWarning("Não consegui salvar a fila", error)))

        const mudar = (f: (eventos: ReadonlyArray<Evento>) => ReadonlyArray<Evento>) =>
          Ref.updateAndGet(estado, f).pipe(Effect.flatMap(salvar), lock.withPermit)

        const adicionar = (origem: string, texto: string) =>
          Effect.gen(function*() {
            const evento: Evento = {
              id: `${Date.now().toString(36)}-${(yield* Random.nextInt).toString(36)}`,
              origem: limparOrigem(origem),
              texto: texto.slice(0, MAX_TEXTO),
              recebido: new Date().toISOString()
            }
            // Acima do limite, os mais antigos saem: a fila nunca cresce sem fim.
            yield* mudar((eventos) => [...eventos, evento].slice(-MAX_PENDENTES))
            return evento
          })

        return {
          adicionar,
          pendentes: Ref.get(estado),
          remover: (ids) => mudar((eventos) => eventos.filter((evento) => !ids.includes(evento.id)))
        }
      })
    )
}
