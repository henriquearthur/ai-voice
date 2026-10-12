#!/usr/bin/env bun
/**
 * Hook PreCompact do maestro.
 *
 * Só age na sessão do maestro: grava em `estado.md`, entre marcadores próprios,
 * um retrato da sessão tirado do transcript (últimos pedidos, subagentes
 * lançados, última resposta). As seções que o maestro mantém ficam intactas;
 * a versão anterior vai para `estado.md.bak`. Nunca bloqueia a compactação.
 */
import { copyFileSync, readFileSync } from "node:fs"
import { atualizarAuto, blocoAuto, ehSessaoDoMaestro, garantirEstado, gravar, maestroDir, resumirTranscript } from "../memoria.ts"

interface Entrada {
  readonly session_id?: string
  readonly transcript_path?: string
  readonly cwd?: string
  readonly trigger?: string
}

try {
  const entrada: Entrada = JSON.parse((await Bun.stdin.text()) || "{}")
  const dir = maestroDir()
  const nome = process.env.JARVIS_MAESTRO_NOME || "maestro"
  if (ehSessaoDoMaestro(entrada.cwd, dir, nome)) {
    const estado = garantirEstado(dir, nome)
    let transcript = ""
    try {
      transcript = entrada.transcript_path ? readFileSync(entrada.transcript_path, "utf8") : ""
    } catch {
      // Sem transcript, o retrato sai vazio, mas a compactação segue.
    }
    const atual = readFileSync(estado, "utf8")
    copyFileSync(estado, `${estado}.bak`)
    gravar(
      estado,
      atualizarAuto(
        atual,
        blocoAuto({
          quando: new Date(),
          sessao: entrada.session_id ?? "?",
          gatilho: entrada.trigger ?? "?",
          resumo: resumirTranscript(transcript)
        })
      )
    )
  }
} catch (error) {
  process.stderr.write(`pre-compact do maestro: ${String(error)}\n`)
}
process.exit(0)
