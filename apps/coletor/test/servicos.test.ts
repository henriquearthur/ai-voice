import { describe, expect, it } from "@effect/vitest"
import { parsePs, Tabela } from "../src/processos.ts"
import { montarServicos, parseAgendaPlist, parseLaunchctlList, parseLaunchctlPrint, RelogioExecucoes } from "../src/servicos.ts"

const LIST = `PID\tStatus\tLabel
11223\t0\tdev.jarvis.dashboard
-\t0\tdev.jarvis.maestro
80087\t0\tdev.jarvis.escuta
69666\t0\tapplication.dev.jarvis.desktop.1.2
123\t0\tcom.apple.algo
`

const PRINT = `gui/501/dev.jarvis.escuta = {
\tactive count = 1
\tpath = /Users/f/Library/LaunchAgents/dev.jarvis.escuta.plist
\tstate = running
\tprogram = /x/Escuta
\truns = 4
\tpid = 80087
\tlast exit code = (never exited)
\tstdout path = /x/escuta.out.log
\tendpoints = {
\t\tstate = active
\t}
}
`

const PRINT_MAESTRO = `gui/501/dev.jarvis.maestro = {
\tactive count = 0
\tpath = /Users/f/Library/LaunchAgents/dev.jarvis.maestro.plist
\tstate = not running
\tstdout path = /x/vigia.out.log
\tstderr path = /x/vigia.err.log
\truns = 11
\tlast exit code = 0
\tresource coalition = {
\t\tstate = active
\t}
\trun interval = 60 seconds
}
`

describe("launchctl", () => {
  it("lê só os dev.jarvis.* do list", () => {
    expect(parseLaunchctlList(LIST)).toEqual([
      { label: "dev.jarvis.dashboard", pid: 11223, ultimaSaida: 0 },
      { label: "dev.jarvis.maestro", pid: null, ultimaSaida: 0 },
      { label: "dev.jarvis.escuta", pid: 80087, ultimaSaida: 0 }
    ])
  })

  it("lê runs, pid e estado do print sem confundir com chaves aninhadas", () => {
    expect(parseLaunchctlPrint(PRINT)).toEqual({
      estado: "running",
      execucoes: 4,
      pid: 80087,
      ultimaSaida: "(never exited)",
      intervaloS: null,
      stdout: "/x/escuta.out.log",
      stderr: null
    })
  })

  it("lê o run interval de um serviço periódico", () => {
    expect(parseLaunchctlPrint(PRINT_MAESTRO)).toMatchObject({
      estado: "not running",
      execucoes: 11,
      pid: null,
      ultimaSaida: "0",
      intervaloS: 60,
      stderr: "/x/vigia.err.log"
    })
  })

  it("lê StartInterval e StartCalendarInterval do plist", () => {
    expect(parseAgendaPlist("<key>RunAtLoad</key><true/>\n<key>StartInterval</key><integer>60</integer>")).toEqual({
      intervaloS: 60
    })
    expect(parseAgendaPlist("<key>StartCalendarInterval</key>\n<dict><key>Hour</key><integer>3</integer></dict>"))
      .toEqual({ intervaloS: null })
    expect(parseAgendaPlist("<key>KeepAlive</key><true/>")).toBeNull()
  })

  it("junta plists, launchctl e ps", () => {
    const tabela = new Tabela(parsePs("80087 1 2048 1.5 /x/Escuta\n"))
    const servicos = montarServicos(
      ["dev.jarvis.escuta", "dev.jarvis.tts"],
      parseLaunchctlList(LIST),
      new Map([["dev.jarvis.escuta", parseLaunchctlPrint(PRINT)]]),
      tabela
    )
    expect(servicos.map((s) => s.label)).toEqual([
      "dev.jarvis.dashboard",
      "dev.jarvis.escuta",
      "dev.jarvis.maestro",
      "dev.jarvis.tts"
    ])
    expect(servicos[1]).toEqual({
      label: "dev.jarvis.escuta",
      carregado: true,
      vivo: true,
      pid: 80087,
      periodico: false,
      intervalo_s: null,
      reinicios: 3,
      execucoes: 4,
      ultima_execucao_em: null,
      ultima_saida: "(never exited)",
      rss_bytes: 2048 * 1024,
      cpu_pct: 1.5
    })
    expect(servicos[0]).toMatchObject({ vivo: false, pid: 11223, reinicios: null })
    expect(servicos[3]).toMatchObject({ carregado: false, vivo: false, pid: null })
  })

  it("periódico sem PID: conta execuções, não reinícios, e guarda a última execução", () => {
    const relogio = new RelogioExecucoes()
    const tabela = new Tabela([])
    const lista = parseLaunchctlList(LIST)
    const logs = new Map([["dev.jarvis.maestro", 1_990_000]])
    const coletar = (print: string, agora: number) =>
      montarServicos(["dev.jarvis.maestro"], lista, new Map([["dev.jarvis.maestro", parseLaunchctlPrint(print)]]), tabela, {
        logsMs: logs,
        relogio,
        agora
      }).find((s) => s.label === "dev.jarvis.maestro")!

    expect(coletar(PRINT_MAESTRO, 2_000_000)).toMatchObject({
      vivo: false,
      pid: null,
      periodico: true,
      intervalo_s: 60,
      reinicios: null,
      execucoes: 11,
      ultima_execucao_em: new Date(1_990_000).toISOString(),
      ultima_saida: "0"
    })
    // O runs subiu entre duas coletas: rodou agora há pouco, mesmo sem escrever log.
    expect(coletar(PRINT_MAESTRO.replace("runs = 11", "runs = 12"), 2_005_000).ultima_execucao_em).toBe(
      new Date(2_005_000).toISOString()
    )
    expect(coletar(PRINT_MAESTRO.replace("runs = 11", "runs = 12"), 2_010_000).ultima_execucao_em).toBe(
      new Date(2_005_000).toISOString()
    )
  })

  it("log antigo só conta depois de observar um intervalo inteiro", () => {
    const relogio = new RelogioExecucoes()
    // Coletor acabou de subir: log de 5 min atrás não prova que o serviço parou.
    expect(relogio.registrar("x", 11, false, 1_000_000, 1_300_000, 60)).toBeNull()
    // Passou mais de um intervalo sem o runs subir: aí o log antigo é a melhor pista.
    expect(relogio.registrar("x", 11, false, 1_000_000, 1_380_000, 60)).toBe(1_000_000)
    // Log recente vale desde a primeira coleta.
    expect(new RelogioExecucoes().registrar("y", 3, false, 1_290_000, 1_300_000, 60)).toBe(1_290_000)
  })

  it("periódico só pelo plist (StartCalendarInterval)", () => {
    const [s] = montarServicos(["dev.jarvis.backup"], [], new Map(), new Tabela([]), {
      agendas: new Map([["dev.jarvis.backup", { intervaloS: null }]])
    })
    expect(s).toMatchObject({ periodico: true, intervalo_s: null, carregado: false, ultima_execucao_em: null })
  })
})
