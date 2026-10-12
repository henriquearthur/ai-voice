import { assert, describe, it } from "@effect/vitest"
import { compose, looksPortuguese, MAX_ANNOUNCEMENT_LENGTH, truncate } from "../src/index.ts"

// Nothing spoken names a speaker or another entity.
const OFF_PERSONA = /claude|grok|jarvis|agente|agent|sess[aã]o|session|o outro|aviso do sistema/i

const ENGLISH_WORDS = /\b(the|and|is|your|needs|waiting|for|input|permission|finished|task|error|failed|read|terminal|use|bash|claude code)\b/i

const textOf = (result: ReturnType<typeof compose>) => {
  assert.strictEqual(result._tag, "text")
  return result._tag === "text" ? result.text : ""
}

describe("compose", () => {
  const englishNotifications = [
    { body: "Claude needs your permission to use Bash", expected: "Preciso da sua permissão pra continuar." },
    { body: "Claude is waiting for your input", expected: "Tô esperando você responder." },
    { body: "Task finished successfully, read the terminal", expected: "Pronto, terminei." },
    { body: "Build failed with 3 errors", expected: "Deu erro, dá uma olhada quando puder." }
  ]
  for (const { body, expected } of englishNotifications) {
    it(`maps "${body}" to a fixed pt-BR template without any English`, () => {
      const text = textOf(compose({ source: "claude-code", title: "Claude Code", body }))
      assert.strictEqual(text, expected)
      assert.notMatch(text, ENGLISH_WORDS)
      assert.notMatch(text, OFF_PERSONA)
    })
  }

  it("speaks every template in the first person, without naming anyone", () => {
    const events = ["permission", "waiting", "finished", "error"] as const
    for (const event of events) {
      for (const project of [undefined, "ai-voice"]) {
        const text = textOf(compose({ source: "claude-code", body: "", event, ...(project ? { project } : {}) }))
        assert.notMatch(text, OFF_PERSONA)
        assert.notMatch(text, ENGLISH_WORDS)
        assert.isAtMost(text.length, MAX_ANNOUNCEMENT_LENGTH)
      }
    }
    assert.strictEqual(
      textOf(compose({ source: "x", body: "", event: "error", project: "api" })),
      "Deu erro em api, dá uma olhada quando puder."
    )
  })

  it("drops Portuguese free text that names another entity", () => {
    assert.strictEqual(
      textOf(compose({ source: "x", body: "O Claude terminou a sessão do projeto", event: "finished" })),
      "Pronto, terminei."
    )
    assert.deepStrictEqual(compose({ source: "x", body: "O outro agente mandou um recado para você" }), {
      _tag: "skip",
      reason: "off-persona"
    })
    assert.strictEqual(
      textOf(compose({ source: "x", body: "", event: "finished", project: "claude-config" })),
      "Pronto, terminei."
    )
  })

  it("uses the explicit event and project", () => {
    assert.strictEqual(
      textOf(compose({ source: "claude-code", body: "", event: "finished", project: "ai-voice" })),
      "Pronto, terminei ai voice."
    )
  })

  it("drops a project name that looks like a path or secret", () => {
    assert.strictEqual(
      textOf(compose({ source: "hook", body: "", event: "finished", project: "/Users/fernando/code/x" })),
      "Pronto, terminei."
    )
  })

  it("appends free text only when it is Portuguese", () => {
    assert.strictEqual(
      textOf(compose({ source: "hook", body: "O deploy do projeto passou em três minutos", event: "finished" })),
      "Pronto, terminei. O deploy do projeto passou em três minutos."
    )
  })

  it("speaks Portuguese free text without a known event", () => {
    assert.strictEqual(
      textOf(compose({ source: "agenda", body: "Lembrete: reunião com o time às 15h" })),
      "Lembrete: reunião com o time às 15h."
    )
  })

  it("skips English free text without a known event", () => {
    assert.deepStrictEqual(compose({ source: "x", body: "The deployment of the backend is live" }), {
      _tag: "skip",
      reason: "non-portuguese"
    })
  })

  it("never lets mixed English through", () => {
    const result = compose({ source: "x", body: "O deploy is done", event: "finished" })
    assert.strictEqual(textOf(result), "Pronto, terminei.")
  })

  it("never says to read the terminal", () => {
    // "Pronto" reads as a finished task; the free text is dropped, only the template is spoken.
    const text = textOf(compose({ source: "x", body: "Pronto, leia o terminal para ver o resultado" }))
    assert.strictEqual(text, "Pronto, terminei.")
    assert.deepStrictEqual(compose({ source: "x", body: "Leia o terminal para ver o resultado" }), {
      _tag: "skip",
      reason: "non-portuguese"
    })
  })

  it("skips empty and secret-only content", () => {
    assert.deepStrictEqual(compose({ source: "x", body: "   " }), { _tag: "skip", reason: "empty" })
    assert.deepStrictEqual(compose({ source: "x", body: "<>" }), { _tag: "skip", reason: "empty" })
    assert.deepStrictEqual(compose({ source: "x", body: "token: sk-proj-AbC123dEf456GhI789jKl0" }), {
      _tag: "skip",
      reason: "secret-only"
    })
  })

  it("keeps secrets out of Portuguese free text", () => {
    const text = textOf(compose({ source: "x", body: "O token ghp_0123456789abcdefABCDEF0123456789abcd da conta venceu hoje" }))
    assert.strictEqual(text, "O token credencial da conta venceu hoje.")
  })

  it("truncates cleanly at a word boundary", () => {
    const long = Array.from({ length: 80 }, () => "palavra de teste").join(" ")
    const text = textOf(compose({ source: "x", body: long }))
    assert.isAtMost(text.length, MAX_ANNOUNCEMENT_LENGTH)
    assert.isTrue(text.endsWith("…"))
    assert.match(text, /(palavra|de|teste)…$/)
    assert.strictEqual(truncate("curto"), "curto")
  })
})

describe("looksPortuguese", () => {
  it("accepts Portuguese and rejects English", () => {
    assert.isTrue(looksPortuguese("A tarefa está pronta"))
    assert.isTrue(looksPortuguese("Testes passaram"))
    assert.isFalse(looksPortuguese("Waiting for approval"))
    assert.isFalse(looksPortuguese("deploy ok"))
  })
})
