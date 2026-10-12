import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { Herdr, startClaude } from "../src/herdr.ts"

describe("startClaude", () => {
  it("nomeia o pane com o nome do agente antes de iniciar o claude", async () => {
    const chamadas: Array<ReadonlyArray<string>> = []
    const falso = Layer.succeed(Herdr, { call: (args) => Effect.sync(() => (chamadas.push(args), {})) })
    await Effect.runPromise(startClaude({ name: "rust-core", pane: "w1:p7", args: ["--x"] }).pipe(Effect.provide(falso)))
    expect(chamadas[0]).toEqual(["pane", "rename", "w1:p7", "rust-core"])
    expect(chamadas[1]?.slice(0, 3)).toEqual(["agent", "start", "rust-core"])
  })
})
