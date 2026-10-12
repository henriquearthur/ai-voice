import { describe, expect, it } from "@effect/vitest"
import { appendFileSync, mkdtempSync, renameSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Seguidor, ultimasLinhas } from "../src/tail.ts"

const novoArquivo = () => join(mkdtempSync(join(tmpdir(), "coletor-tail-")), "eventos.jsonl")

describe("Seguidor", () => {
  it("devolve só linhas completas e guarda o pedaço incompleto", () => {
    const f = novoArquivo()
    const s = new Seguidor(f)
    expect(s.ler()).toEqual([])
    writeFileSync(f, "a\nb")
    expect(s.ler()).toEqual(["a"])
    appendFileSync(f, "c\n\nd\n")
    expect(s.ler()).toEqual(["bc", "d"])
    expect(s.ler()).toEqual([])
  })

  it("doFim pula o que já estava no arquivo", () => {
    const f = novoArquivo()
    writeFileSync(f, "velho\n")
    const s = new Seguidor(f, { doFim: true })
    expect(s.ler()).toEqual([])
    appendFileSync(f, "novo\n")
    expect(s.ler()).toEqual(["novo"])
  })

  it("recomeça quando o arquivo é truncado ou trocado", () => {
    const f = novoArquivo()
    writeFileSync(f, "um\ndois\n")
    const s = new Seguidor(f)
    expect(s.ler()).toEqual(["um", "dois"])
    writeFileSync(f, "x\n")
    expect(s.ler()).toEqual(["x"])
    renameSync(f, `${f}.1`)
    writeFileSync(`${f}.tmp`, "rodado\n")
    renameSync(`${f}.tmp`, f)
    expect(s.ler()).toEqual(["rodado"])
  })
})

describe("ultimasLinhas", () => {
  it("descarta a primeira linha cortada", () => {
    const f = novoArquivo()
    writeFileSync(f, "aaaaaaaaaa\nbb\ncc\n")
    expect(ultimasLinhas(f, 8)).toEqual(["bb", "cc"])
    expect(ultimasLinhas(f, 4)).toEqual(["cc"])
    expect(ultimasLinhas(f)).toEqual(["aaaaaaaaaa", "bb", "cc"])
    expect(ultimasLinhas(`${f}.nao-existe`)).toEqual([])
  })
})
