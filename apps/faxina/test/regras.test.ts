import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"
import { compilarConfig } from "../src/config.ts"
import { filtrarCrescimento, filtrarNovos } from "../src/estado.ts"
import { parseEtime, parsePs } from "../src/ps.ts"
import { avaliar, type CpuVisto } from "../src/regras.ts"

const config = compilarConfig(JSON.parse(readFileSync(new URL("../faxina.config.json", import.meta.url), "utf8")))
const UID = 501
const H = "/Users/f"

// pid ppid pgid stat etime %cpu rss(KiB) uid command
const PS = `  PID  PPID  PGID STAT     ELAPSED  %CPU    RSS   UID COMMAND
    1     0     1 Ss   12-03:53:00   0.1   9000     0 /sbin/launchd
   42     1    42 S    12-03:53:00   0.0   1000   501 ./Escuta --stt parakeet --audio /tmp/scratchpad/x.wav
  500     1   500 S       02:00:00   0.5  80000   501 ${H}/.local/share/jarvis/bin/Escuta.app/Contents/MacOS/Escuta
  501     1   501 S       00:15:00   0.5  80000   501 ./Escuta --stt parakeet --audio /tmp/scratchpad/orfa.wav
  502     1   502 S       00:03:00   0.5  80000   501 ./Escuta --stt parakeet --audio /tmp/scratchpad/cal2/a.wav
  503   900   503 S       00:30:00   0.5  80000   501 ./Escuta --stt parakeet --audio /tmp/scratchpad/cal2/b.wav
  504   900   504 S      1-02:00:00   0.5  80000   501 ./Escuta --stt parakeet --audio /tmp/scratchpad/cal2/c.wav
  505     1   505 S       00:20:00   0.5  80000   501 ${H}/repo/apps/escuta/.build/release/Escuta
  506     1   506 S       00:20:00   0.5  80000   999 ./Escuta --stt parakeet
  510     1   510 S       00:40:00   0.5  80000   501 swift-build --build-path .build
  511   900   511 S       00:45:00   0.5  80000   501 /usr/bin/swift build -c release
  512   900   512 S       00:05:00   0.5  80000   501 cargo build --release
  513     1   513 S       00:12:00   0.5  80000   501 bun test --timeout 5000
  514   900   514 S       00:50:00   0.5  80000   501 node /repo/node_modules/.bin/vitest run
  515     1   515 S       00:50:00   0.5  80000   501 /usr/bin/python3 /tmp/scratchpad/bench/bench_tts.py
  516     1   516 S       00:50:00   0.5  80000   501 /usr/bin/python3 /repo/outro.py
  517     1   517 S       00:50:00   0.5  80000   501 /bin/zsh -c cd /tmp/scratchpad && bun test
  520     1   520 Z       05:00:00   0.0      0   501 (node) <defunct>
  530   900   530 S       00:30:00   1.0  60000   501 claude --resume
  531     1   531 S    03-00:00:00   1.0  60000   501 /Users/f/.local/bin/herdr server
  532   530   532 S       00:30:00  45.0  90000   501 node /x/typescript/lib/tsserver.js
  533     1   533 S       00:30:00   1.0 2000000   501 /Applications/OrbStack.app/Contents/MacOS/OrbStack Helper
  534   900   534 S       00:30:00   2.0  80000   501 /Users/f/.local/share/jarvis/tts/.venv/bin/python -I server.py
  535     1   535 S       00:50:00   0.5  80000   501 codex --full-auto
  536   530   536 S       00:50:00   0.5  80000   501 bun test tests/
  900     1   900 Ss      05:00:00   0.0   2000   501 /bin/zsh
`

const procs = parsePs(PS)
const roda = (cpuAnterior: CpuVisto = {}, lista = procs) =>
  avaliar(lista, { config, uid: UID, meuPid: 9999, cpuAnterior })
const pidsMatar = (r = roda()) => r.matar.map((a) => a.proc.pid).sort((a, b) => a - b)

describe("ps", () => {
  it("lê etime em todos os formatos", () => {
    expect(parseEtime("05:30")).toBe(330)
    expect(parseEtime("02:00:00")).toBe(7200)
    expect(parseEtime("12-03:53:00")).toBe(12 * 86400 + 3 * 3600 + 53 * 60)
    expect(Number.isNaN(parseEtime("abc"))).toBe(true)
  })
  it("lê todas as colunas e ignora o cabeçalho", () => {
    expect(procs.length).toBe(26)
    expect(procs.find((p) => p.pid === 532)).toMatchObject({ ppid: 530, cpuPct: 45, rssBytes: 90000 * 1024, uid: 501 })
  })
})

describe("zumbis", () => {
  it("registra o zumbi e sinaliza o pai, sem matar", () => {
    const r = roda()
    expect(r.zumbis.map((z) => z.pid)).toEqual([520])
    expect(r.alertas.find((a) => a.tipo === "zumbi")?.chave).toBe("zumbi:520")
    expect(pidsMatar(r)).not.toContain(520)
  })
})

describe("lixo conhecido", () => {
  it("mata só o que casa com a lista, respeitando idade e pai vivo", () => {
    // 42 (pid<100, protegido), 501 (órfã, 15 min), 505 (.build, órfã 20 min), 510 swift-build órfão 40 min,
    // 513 bun test órfão 12 min, 511 e 514 pai vivo com mais de 30 min, 515 python bench órfão.
    expect(pidsMatar()).toEqual([501, 504, 505, 510, 511, 513, 514, 515, 536])
  })
  it("respeita Escuta de calibração nova ou com pai vivo", () => {
    const poupados = roda().poupados.map((a) => a.proc.pid)
    expect(poupados).toContain(502) // órfã com 3 min
    expect(poupados).toContain(503) // pai vivo, 30 min
    expect(poupados).toContain(512) // cargo build 5 min com pai vivo
  })
  it("nunca toca a Escuta instalada, outro uid, nem python fora do padrão", () => {
    const m = pidsMatar()
    for (const pid of [500, 506, 516, 517]) expect(m).not.toContain(pid)
  })
  it("pid abaixo de 100 nunca morre, mesmo casando e velho", () => {
    const r = roda()
    expect(pidsMatar(r)).not.toContain(42)
    expect(r.poupados.find((a) => a.proc.pid === 42)?.motivo).toMatch(/pid abaixo/)
  })
  it("o limite de pid também vale com a config tentando baixar", () => {
    const frouxa = compilarConfig({ ...JSON.parse(readFileSync(new URL("../faxina.config.json", import.meta.url), "utf8")), limites: { pidMinimo: 1 } })
    expect(frouxa.limites.pidMinimo).toBe(100)
    const r = avaliar(procs, { config: frouxa, uid: UID, meuPid: 9999, cpuAnterior: {} })
    expect(r.matar.map((a) => a.proc.pid)).not.toContain(42)
  })
})

describe("Escuta sem ESCUTA_LOCK próprio", () => {
  const ps = `  600  900  600 S  00:01:00  0.5  80000  501 ./Escuta --stt parakeet --audio /tmp/scratchpad/a.wav
  601  900  601 S  00:01:00  0.5  80000  501 ./Escuta --stt parakeet --audio /tmp/scratchpad/b.wav
  602  900  602 S  00:01:00  0.5  80000  501 ./Escuta --stt parakeet --audio /tmp/scratchpad/c.wav
  603  900  603 S  00:01:00  0.5  80000  501 ${H}/.local/share/jarvis/bin/Escuta.app/Contents/MacOS/Escuta
   60    1   60 S  00:01:00  0.5  80000  501 ./Escuta
  900    1  900 Ss 05:00:00  0.0   2000  501 /bin/zsh
`
  const envs: Record<number, string | undefined> = {
    600: "./Escuta --stt FOO=1 PATH=/bin",
    601: "./Escuta --stt ESCUTA_LOCK=/tmp/cal2/lock PATH=/bin",
    602: undefined,
    603: "Escuta PATH=/bin",
    60: "./Escuta PATH=/bin"
  }
  const r = avaliar(parsePs(ps), { config, uid: UID, meuPid: 9999, cpuAnterior: {}, ambiente: (pid) => envs[pid] })
  it("mata na hora, com 1 min e pai vivo, quando falta o lock", () => {
    expect(r.matar.map((a) => a.proc.pid)).toEqual([600])
    expect(r.matar[0]?.motivo).toMatch(/ESCUTA_LOCK/)
  })
  it("poupa quem tem lock próprio, ambiente ilegível, a instalada e PID < 100", () => {
    const p = r.poupados.map((a) => a.proc.pid)
    expect(p).toContain(601)
    expect(p).toContain(602)
    expect(p).toContain(60)
    expect(r.matar.map((a) => a.proc.pid)).not.toContain(603)
  })
})

describe("pontes chrome-devtools órfãs", () => {
  const PT = "/m/chrome-devtools-axi/dist/bin/chrome-devtools-axi-bridge.js"
  const ps = `  700    1  700 S  02:00:00  0.1  50000  501 node ${PT}
  701  700  701 S  02:00:00  0.1  50000  501 npm exec chrome-devtools-mcp@latest --browserUrl=http://127.0.0.1:9333
  702  701  702 S  02:00:00  0.1  50000  501 chrome-devtools-mcp
  703  702  703 S  02:00:00  0.1  50000  501 node /x/chrome-devtools-mcp/build/src/telemetry/watchdog/main.js --parent-pid=702
  710    1  710 S  00:30:00  0.1  50000  501 node ${PT}
  711  710  711 S  00:30:00  0.1  50000  501 npm exec chrome-devtools-mcp@latest
  720  900  720 S  05:00:00  0.1  50000  501 node ${PT}
  721  720  721 S  05:00:00  0.1  50000  501 chrome-devtools-mcp
  730    1  730 S  05:00:00  0.1  50000  999 node ${PT}
  800  900  800 S  05:00:00  0.1  50000  501 claude --resume
  801  800  801 S  05:00:00  0.1  50000  501 node /x/outra-coisa.js
  900    1  900 Ss 06:00:00  0.0   2000  501 /bin/zsh
`
  const r = avaliar(parsePs(ps), { config, uid: UID, meuPid: 9999, cpuAnterior: {} })
  const m = r.matar.map((a) => a.proc.pid).sort((a, b) => a - b)
  it("órfã com mais de 1 h morre, com a árvore inteira de filhos", () => {
    expect(m).toEqual([700, 701, 702, 703])
  })
  it("órfã com menos de 1 h fica, e os filhos dela também", () => {
    expect(m).not.toContain(710)
    expect(m).not.toContain(711)
    expect(r.poupados.find((a) => a.proc.pid === 710)?.motivo).toMatch(/órfão, mas só/)
  })
  it("ponte com pai vivo fica, por mais velha que seja", () => {
    expect(m).not.toContain(720)
    expect(m).not.toContain(721)
    expect(r.poupados.find((a) => a.proc.pid === 720)?.motivo).toMatch(/pai 900 vivo/)
  })
  it("outro uid e claude ficam", () => {
    expect(m).not.toContain(730)
    expect(m).not.toContain(800)
    expect(m).not.toContain(801)
  })
})

describe("nunca mate", () => {
  it("claude, codex e herdr, mesmo que um padrão de lixo os casasse", () => {
    const frouxa = compilarConfig({ lixo: [{ padrao: "tudo", comando: ".*", idadeMinS: 0 }] })
    const lista = parsePs(`  200  1  200 S  05:00:00  0.1  1000  501 claude --resume
  201  1  201 S  05:00:00  0.1  1000  501 codex
  202  1  202 S  05:00:00  0.1  1000  501 /Users/f/.local/bin/herdr server
  203  1  203 S  05:00:00  0.1  1000  501 /bin/sleep 1000`)
    const r = avaliar(lista, { config: frouxa, uid: UID, meuPid: 9999, cpuAnterior: {} })
    expect(r.matar.map((a) => a.proc.pid)).toEqual([203])
    expect(r.poupados.map((a) => a.proc.pid).sort()).toEqual([200, 201, 202])
  })
  it("processo da allowlist (Kokoro, OrbStack) e ancestral de claude", () => {
    const m = pidsMatar()
    expect(m).not.toContain(530)
    expect(m).not.toContain(531)
    expect(m).not.toContain(533)
    expect(m).not.toContain(534)
    expect(m).not.toContain(535)
    expect(m).not.toContain(900) // zsh pai do claude
  })
  it("um bun test dentro da sessão claude com pai vivo e velho é mesmo alvo, mas nunca o claude em si", () => {
    expect(pidsMatar()).toContain(514)
    expect(pidsMatar()).not.toContain(530)
  })
  it("processo de outro uid nunca é alvo nem alerta", () => {
    const r = roda()
    expect(r.matar.some((a) => a.proc.uid !== UID)).toBe(false)
  })
})

describe("descontrolados", () => {
  it("só alerta por CPU depois de 5 passadas seguidas", () => {
    let visto: CpuVisto = {}
    for (let i = 1; i <= 5; i++) {
      const r = roda(visto)
      expect(r.alertas.some((a) => a.tipo === "cpu" && a.proc.pid === 532)).toBe(i === 5)
      visto = r.cpuVisto
    }
    expect(visto["532"]?.n).toBe(5)
  })
  it("zera a contagem se o pid foi reaproveitado (idade menor)", () => {
    const r = roda({ "532": { n: 4, idadeS: 999999 } })
    expect(r.cpuVisto["532"]?.n).toBe(1)
  })
  const orb = (pid: number, gb: number) =>
    parsePs(`  PID  PPID  PGID STAT ELAPSED %CPU RSS UID COMMAND\n  ${pid} 1 ${pid} S 00:30:00 1.0 ${Math.round(gb * 1024 ** 2)} 501 /Applications/OrbStack.app/Contents/MacOS/OrbStack Helper`)
  const alertaOrb = (pid: number, gb: number) => roda({}, orb(pid, gb)).alertas.find((x) => x.tipo === "memoria")
  it("OrbStack abaixo de 3,5 GB não avisa", () => {
    expect(alertaOrb(533, 2.8)).toBeUndefined()
    expect(alertaOrb(533, 1.9)).toBeUndefined()
  })
  it("OrbStack acima de 3,5 GB avisa, marcado como conhecido, sem matar", () => {
    const r = roda({}, orb(533, 3.6))
    const a = r.alertas.find((x) => x.tipo === "memoria")
    expect(a).toMatchObject({ item: "container-orbstack", conhecido: true, chave: "memoria:container-orbstack" })
    expect(r.matar.length).toBe(0)
  })
  it("processo sem limite próprio segue o global de 1,5 GB", () => {
    const [p] = parsePs(`  PID  PPID  PGID STAT ELAPSED %CPU RSS UID COMMAND\n  540 1 540 S 00:30:00 1.0 ${2 * 1024 ** 2} 501 /Users/f/.local/bin/herdr server`)
    expect(roda({}, [p!]).alertas.find((x) => x.tipo === "memoria")?.item).toBe("herdr")
  })
  it("tsserver do claude alerta mas não morre", () => {
    const r = roda({ "532": { n: 4, idadeS: 0 } })
    expect(r.alertas.find((a) => a.tipo === "cpu")?.proc.pid).toBe(532)
    expect(pidsMatar(r)).not.toContain(532)
  })
})

describe("dedupe", () => {
  it("o mesmo alerta só volta depois de 30 min", () => {
    const a = [{ chave: "cpu:1:node" }]
    const um = filtrarNovos(a, {}, 0, 30)
    expect(um.novos.length).toBe(1)
    expect(filtrarNovos(a, um.enviados, 29 * 60_000, 30).novos.length).toBe(0)
    expect(filtrarNovos(a, um.enviados, 31 * 60_000, 30).novos.length).toBe(1)
  })
})

describe("crescimento de memória", () => {
  const GB = 1024 ** 3
  const al = (item: string, gb: number) => [{ item, rssBytes: gb * GB }]
  it("primeira vez acima do limite avisa", () => {
    expect(filtrarCrescimento(al("container-orbstack", 3.6), {}, 0.25).novos.length).toBe(1)
  })
  it("estável acima do limite não repete", () => {
    const um = filtrarCrescimento(al("container-orbstack", 3.6), {}, 0.25)
    const dois = filtrarCrescimento(al("container-orbstack", 3.7), um.memoria, 0.25)
    expect(dois.novos.length).toBe(0)
    expect(dois.memoria["container-orbstack"]).toBe(3.6 * GB)
  })
  it("crescimento de 25% ou mais avisa de novo", () => {
    const um = filtrarCrescimento(al("container-orbstack", 4), {}, 0.25)
    expect(filtrarCrescimento(al("container-orbstack", 4.99), um.memoria, 0.25).novos.length).toBe(0)
    const tres = filtrarCrescimento(al("container-orbstack", 5), um.memoria, 0.25)
    expect(tres.novos.length).toBe(1)
    expect(tres.memoria["container-orbstack"]).toBe(5 * GB)
  })
  it("troca de PID mantém o estado (chave é o item)", () => {
    const r1 = avaliar(parsePs(`  PID  PPID  PGID STAT ELAPSED %CPU RSS UID COMMAND\n  600 1 600 S 00:30:00 1.0 ${4 * 1024 ** 2} 501 /Applications/OrbStack.app/Contents/MacOS/OrbStack Helper`), { config, uid: UID, meuPid: 9999, cpuAnterior: {} })
    const r2 = avaliar(parsePs(`  PID  PPID  PGID STAT ELAPSED %CPU RSS UID COMMAND\n  777 1 777 S 00:01:00 1.0 ${4 * 1024 ** 2} 501 /Applications/OrbStack.app/Contents/MacOS/OrbStack Helper`), { config, uid: UID, meuPid: 9999, cpuAnterior: {} })
    const a1 = r1.alertas.filter((a): a is typeof a & { item: string; rssBytes: number } => a.item !== undefined && a.rssBytes !== undefined)
    const a2 = r2.alertas.filter((a): a is typeof a & { item: string; rssBytes: number } => a.item !== undefined && a.rssBytes !== undefined)
    expect(a1[0]!.chave).toBe(a2[0]!.chave)
    const um = filtrarCrescimento(a1, {}, 0.25)
    expect(um.novos.length).toBe(1)
    expect(filtrarCrescimento(a2, um.memoria, 0.25).novos.length).toBe(0)
  })
  it("voltar abaixo do limite esquece o item", () => {
    const um = filtrarCrescimento(al("x", 4), {}, 0.25)
    const vazio = filtrarCrescimento([], um.memoria, 0.25)
    expect(vazio.memoria).toEqual({})
  })
})
