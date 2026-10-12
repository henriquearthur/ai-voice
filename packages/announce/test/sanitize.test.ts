import { assert, describe, it } from "@effect/vitest"
import { sanitize } from "../src/index.ts"

const cases: ReadonlyArray<readonly [string, string, string]> = [
  ["sk- key", "chave sk-proj-AbC123dEf456GhI789jKl0", "sk-proj-AbC123dEf456GhI789jKl0"],
  ["Anthropic key", "chave sk-ant-api03-abcdefghijklmnop", "sk-ant-api03-abcdefghijklmnop"],
  ["GitHub token", "token ghp_0123456789abcdefABCDEF0123456789abcd", "ghp_0123456789abcdefABCDEF0123456789abcd"],
  ["GitHub PAT", "pat github_pat_11ABCDEFG0123456789_abcdefghijklmnop", "github_pat_11ABCDEFG0123456789"],
  ["Slack token", "slack xoxb-1234567890-abcdefghij", "xoxb-1234567890-abcdefghij"],
  ["AWS key id", "aws AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
  [
    "JWT",
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "eyJhbGciOiJIUzI1NiJ9"
  ],
  ["Bearer header", "Authorization: Bearer abc.def-ghi", "abc.def-ghi"],
  ["URL with query", "veja https://example.com/cb?code=s3cr3t&state=x", "s3cr3t"],
  ["URL with credentials", "repo https://user:hunter2@git.example.com/repo.git", "hunter2"],
  ["absolute path", "arquivo /Users/fernando/projetos/segredo.txt salvo", "/Users/fernando"],
  ["home path", "arquivo ~/.ssh/id_ed25519 lido", ".ssh"],
  ["email", "mande para fernando.teste@example.com hoje", "fernando.teste@example.com"],
  ["long hex", "commit 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b pronto", "9f86d081884c"],
  ["long base64", "blob QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0NTY3ODk= fim", "QUJDREVGR0hJSktM"],
  ["high-entropy token", "segredo Zx9Qp2Lm7Rt4Vb8N fim", "Zx9Qp2Lm7Rt4Vb8N"]
]

describe("sanitize", () => {
  for (const [name, input, secret] of cases) {
    it(`removes a ${name}`, () => {
      const result = sanitize(input)
      assert.notInclude(result.text, secret)
      assert.isAbove(result.redactions, 0)
    })
  }

  it("keeps ordinary Portuguese untouched", () => {
    const result = sanitize("O deploy do projeto passou em 3 minutos.")
    assert.strictEqual(result.text, "O deploy do projeto passou em 3 minutos.")
    assert.strictEqual(result.redactions, 0)
  })

  it("flattens to one line and strips SSML brackets", () => {
    const result = sanitize("linha um\nlinha <speak>dois</speak>\r\n& três")
    assert.notMatch(result.text, /[<>\n\r]/)
    assert.strictEqual(result.text, "linha um linha speak dois /speak e três")
  })

  it("counts no meaningful words when only secrets remain", () => {
    assert.strictEqual(sanitize("sk-proj-AbC123dEf456GhI789jKl0 /Users/x/y").meaningfulWords, 0)
  })
})
