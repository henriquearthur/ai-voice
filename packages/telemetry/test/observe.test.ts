import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Metric } from "effect"
import * as Telemetry from "../src/index.ts"

const countOf = (labels: Record<string, string>) =>
  Metric.value(Metric.withAttributes(Telemetry.operationCount, labels)).pipe(Effect.map((state) => state.count))

describe("observe", () => {
  it.effect("counts successes and failures by operation, outcome and error tag", () =>
    Effect.gen(function*() {
      yield* Effect.void.pipe(Telemetry.observe("teste.ok", { servidor: "t" }))
      yield* Effect.fail({ _tag: "Falhou" as const }).pipe(
        Telemetry.observe("teste.erro", { servidor: "t" }),
        Effect.ignore
      )
      assert.strictEqual(yield* countOf({ servidor: "t", operacao: "teste.ok", resultado: "ok", erro: "" }), 1)
      assert.strictEqual(
        yield* countOf({ servidor: "t", operacao: "teste.erro", resultado: "erro", erro: "Falhou" }),
        1
      )
    }))

  it.effect("wraps every tool handler without changing its result", () =>
    Effect.gen(function*() {
      const tools = Telemetry.observeTools("t2", { dobro: (n: number) => Effect.succeed(n * 2) })
      assert.strictEqual(yield* tools.dobro(21), 42)
      assert.strictEqual(
        yield* countOf({ servidor: "t2", ferramenta: "dobro", operacao: "t2.dobro", resultado: "ok", erro: "" }),
        1
      )
    }))
})

describe("layer", () => {
  it.effect("is a no-op when JARVIS_TELEMETRY=0", () =>
    Effect.gen(function*() {
      yield* Effect.void.pipe(Effect.provide(Telemetry.layer({ serviceName: "jarvis-teste" })))
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ JARVIS_TELEMETRY: "0" })))))
})
