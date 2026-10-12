import { describe, expect, it } from "@effect/vitest"
import { Option } from "effect"
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_PORT } from "../src/config.ts"
import { decidir } from "../src/entrega.ts"
import { formatarEntrega, limparOrigem } from "../src/fila.ts"
import { atualizarAuto, AUTO_FIM, AUTO_INICIO, ehMaestro, ehSessaoDoMaestro, renderizar, resumirTranscript } from "../src/memoria.ts"
import { devidas, type Rotina } from "../src/rotinas.ts"
import { deveRetomar, promptRetomada } from "../src/retomada.ts"
import { AgentesJson, alvoEspecialista, alvoMaestro, argsClaude, hooksSettings, REPO } from "../src/vigia.ts"
import { readFileSync } from "node:fs"
import { Schema } from "effect"

describe("decidir", () => {
  const base = { pendentes: 2, avisado: false }
  it("entrega só com o maestro idle ou done", () => {
    expect(decidir({ ...base, status: Option.some("idle") })).toBe("entregar")
    expect(decidir({ ...base, status: Option.some("done") })).toBe("entregar")
    expect(decidir({ ...base, status: Option.some("working") })).toBe("esperar")
    expect(decidir({ ...base, status: Option.some("unknown") })).toBe("esperar")
    expect(decidir({ ...base, status: Option.none() })).toBe("esperar")
  })
  it("avisa uma vez por bloqueio", () => {
    expect(decidir({ ...base, status: Option.some("blocked") })).toBe("avisar")
    expect(decidir({ ...base, avisado: true, status: Option.some("blocked") })).toBe("esperar")
  })
  it("fila vazia nunca faz nada", () => {
    expect(decidir({ pendentes: 0, avisado: false, status: Option.some("idle") })).toBe("esperar")
  })
})

describe("fila", () => {
  it("junta os eventos com o marcador", () => {
    const eventos = [
      { id: "1", origem: "rotina:bom-dia", texto: "Resuma a agenda. ", recebido: "" },
      { id: "2", origem: "teste", texto: "responda só ok", recebido: "" }
    ]
    expect(formatarEntrega(eventos)).toBe("[evento: rotina:bom-dia] Resuma a agenda.\n\n[evento: teste] responda só ok")
  })
  it("limpa a origem", () => {
    expect(limparOrigem("  a]b\n[c  ")).toBe("a b c")
    expect(limparOrigem("")).toBe("desconhecida")
    expect(limparOrigem("x".repeat(100))).toHaveLength(60)
  })
})

describe("rotinas", () => {
  const rotina: Rotina = { nome: "bom-dia", horario: "08:30", texto: "oi" }
  // 2026-10-12 é uma segunda-feira.
  const em = (h: number, m: number) => new Date(2026, 9, 12, h, m)
  it("dispara no horário e até 10 min depois, uma vez por dia", () => {
    expect(devidas([rotina], em(8, 29), {})).toHaveLength(0)
    expect(devidas([rotina], em(8, 30), {})).toHaveLength(1)
    expect(devidas([rotina], em(8, 39), {})).toHaveLength(1)
    expect(devidas([rotina], em(8, 40), {})).toHaveLength(0)
    expect(devidas([rotina], em(8, 31), { "bom-dia": "2026-10-12" })).toHaveLength(0)
    expect(devidas([rotina], em(8, 31), { "bom-dia": "2026-10-11" })).toHaveLength(1)
  })
  it("respeita os dias da semana", () => {
    expect(devidas([{ ...rotina, dias: ["seg"] }], em(8, 30), {})).toHaveLength(1)
    expect(devidas([{ ...rotina, dias: ["sab", "dom"] }], em(8, 30), {})).toHaveLength(0)
  })
})

describe("memória", () => {
  it("substitui só o bloco automático", () => {
    const primeiro = atualizarAuto("# Estado\n\n## Pendências\n- x\n", "bloco 1")
    expect(primeiro).toContain(`${AUTO_INICIO}\nbloco 1\n${AUTO_FIM}`)
    const segundo = atualizarAuto(primeiro, "bloco 2")
    expect(segundo).toContain("## Pendências\n- x")
    expect(segundo).toContain("bloco 2")
    expect(segundo).not.toContain("bloco 1")
  })
  it("resume o transcript", () => {
    const linhas = [
      { type: "user", message: { content: "<system-reminder>ignorar</system-reminder>" } },
      { type: "user", message: { content: "corrija o build" } },
      { type: "user", isMeta: true, message: { content: "meta" } },
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Agent", input: { description: "Corrigir build" } },
            { type: "text", text: "Lancei um subagente." }
          ]
        }
      },
      { type: "user", message: { content: [{ type: "tool_result", content: "x" }] } }
    ].map((l) => JSON.stringify(l)).join("\n") + "\nlixo\n"
    expect(resumirTranscript(linhas)).toEqual({
      pedidos: ["corrija o build"],
      subagentes: ["Corrigir build"],
      ultimaResposta: "Lancei um subagente."
    })
  })
  it("reconhece só a casa do maestro", () => {
    const dir = mkdtempSync(join(tmpdir(), "maestro-"))
    mkdirSync(join(dir, "casa", "sub"), { recursive: true })
    expect(ehMaestro(join(dir, "casa"), dir)).toBe(true)
    expect(ehMaestro(join(dir, "casa", "sub"), dir)).toBe(true)
    expect(ehMaestro(dir, dir)).toBe(false)
    expect(ehMaestro(join(dir, "casa2"), dir)).toBe(false)
    expect(ehMaestro(undefined, dir)).toBe(false)
  })
  it("reconhece o maestro pelo pane do vigia ou pelo nome no herdr", () => {
    const dir = mkdtempSync(join(tmpdir(), "maestro-"))
    const herdr = join(dir, "herdr")
    writeFileSync(herdr, `#!/bin/bash\n[ "$3" = "w1:p2" ] && echo '{"result":{"agent":{"name":"maestro"}}}' || echo '{"result":{"agent":{}}}'\n`)
    chmodSync(herdr, 0o755)
    expect(ehSessaoDoMaestro("/repo", dir, "maestro", { JARVIS_MAESTRO_NOME: "maestro" })).toBe(true)
    expect(ehSessaoDoMaestro("/repo", dir, "maestro", { JARVIS_HERDR: herdr, HERDR_PANE_ID: "w1:p2" })).toBe(true)
    expect(ehSessaoDoMaestro("/repo", dir, "maestro", { JARVIS_HERDR: herdr, HERDR_PANE_ID: "w1:p3" })).toBe(false)
    expect(ehSessaoDoMaestro("/repo", dir, "maestro", {})).toBe(false)
  })
  it("renderiza os modelos", () => {
    expect(renderizar("@NOME@ fala com @FALA@ @NOME@", { NOME: "m", FALA: "f" })).toBe("m fala com f m")
  })
})

describe("vigia", () => {
  it("monta os argumentos do claude", () => {
    const base = { sistema: "/s.md", fala: "/bin/fala", settings: "" }
    expect(argsClaude({ ...base, resume: Option.none() })).toEqual([
      "--append-system-prompt-file", "/s.md", "--allowedTools", "Bash(/bin/fala:*)"
    ])
    expect(argsClaude({ ...base, settings: "/h.json", resume: Option.some("abc") })).toEqual([
      "--resume", "abc", "--append-system-prompt-file", "/s.md", "--allowedTools", "Bash(/bin/fala:*)",
      "--settings", "/h.json"
    ])
    expect(argsClaude({ ...base, model: "sonnet", resume: Option.some("abc") })).toEqual([
      "--resume", "abc", "--model", "sonnet", "--append-system-prompt-file", "/s.md", "--allowedTools",
      "Bash(/bin/fala:*)"
    ])
  })
})

describe("config", () => {
  it("usa a 7353, fora das portas do Grafana (7351) e do coletor (7352)", () => {
    expect(DEFAULT_PORT).toBe(7353)
  })
})

describe("especialistas", () => {
  const config = {
    name: "maestro", dir: "/m", workspace: "ai-voice", herdr: "/h", fala: "/f", port: 7353, settings: ""
  }
  it("o exemplo de agentes.json é válido e traz os três especialistas", () => {
    const texto = readFileSync(new URL("../agentes.example.json", import.meta.url), "utf8")
    const { agentes } = Schema.decodeUnknownSync(AgentesJson)(texto)
    expect(agentes.map((a) => a.nome)).toEqual(["otimizacao", "escuta-voz", "telemetria"])
  })
  it("recusa nome que o herdr não aceita", () => {
    expect(() => Schema.decodeUnknownSync(AgentesJson)('{"agentes":[{"nome":"Ruim!","papel":"p","prompt":"x"}]}')).toThrow()
  })
  it("cada especialista tem pasta, prompt e acesso ao repositório próprios", () => {
    const alvo = alvoEspecialista(config, { nome: "telemetria", papel: "painéis", prompt: "cuide" })
    expect(alvo.dir).toBe("/m/agentes/telemetria")
    expect(alvo.valores).toMatchObject({ NOME: "telemetria", PAPEL: "painéis", PROMPT: "cuide", MAESTRO: "maestro", REPO })
    expect(alvo.addDirs).toEqual([REPO])
    expect(REPO.endsWith("ai-voice")).toBe(true)
  })
})

describe("hooks dos agentes do vigia", () => {
  it("aponta SessionStart e PreCompact para os scripts do repositório", () => {
    const { hooks } = hooksSettings("/bun")
    expect(hooks.SessionStart[0]!.matcher).toBe("startup|resume|compact|clear")
    expect(hooks.SessionStart[0]!.hooks[0]!.command).toBe(`/bun ${REPO}/apps/maestro/src/hooks/session-start.ts`)
    expect(hooks.PreCompact[0]!.hooks[0]!.command).toBe(`/bun ${REPO}/apps/maestro/src/hooks/pre-compact.ts`)
  })
})

describe("retomada do papel", () => {
  const config = { name: "maestro", dir: "/tmp/m", workspace: "maestro", herdr: "h", fala: "/bin/fala", port: 1, settings: "" }
  it("o prompt do especialista traz papel, missão, estado e sistema", () => {
    const alvo = alvoEspecialista(config, { nome: "telemetria", papel: "dono do coletor", prompt: "Mantenha o Grafana." })
    const texto = promptRetomada(alvo)
    expect(texto).toContain("[retomada: telemetria]")
    expect(texto).toContain("Papel: dono do coletor.")
    expect(texto).toContain("Mantenha o Grafana.")
    expect(texto).toContain("/tmp/m/agentes/telemetria/estado.md")
    expect(texto).toContain("/tmp/m/agentes/telemetria/sistema.md")
    expect(promptRetomada(alvo)).toBe(texto)
  })
  it("o maestro retoma pelo sistema.md", () => {
    const texto = promptRetomada(alvoMaestro(config))
    expect(texto).toContain("[retomada: maestro]")
    expect(texto).toContain("/tmp/m/sistema.md")
    expect(texto).not.toContain("Missão")
  })
  it("só manda com o agente parado, nunca trabalhando ou bloqueado", () => {
    expect(deveRetomar(Option.some("idle"))).toBe(true)
    expect(deveRetomar(Option.some("done"))).toBe(true)
    expect(deveRetomar(Option.some("working"))).toBe(false)
    expect(deveRetomar(Option.some("blocked"))).toBe(false)
    expect(deveRetomar(Option.none())).toBe(false)
  })
})
