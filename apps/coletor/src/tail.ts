import { closeSync, openSync, readSync, statSync } from "node:fs"

/**
 * `tail -F` por polling: guarda o deslocamento e o inode do arquivo e, a cada
 * `ler()`, devolve só as linhas completas novas. Se o arquivo for truncado ou
 * trocado (rotação), recomeça do início do arquivo novo. Um arquivo que ainda
 * não existe só devolve nada.
 */
export class Seguidor {
  private deslocamento = 0
  private inode: number | undefined
  private resto = ""

  constructor(private readonly caminho: string, opcoes: { readonly doFim?: boolean } = {}) {
    if (opcoes.doFim) {
      const info = estatistica(caminho)
      if (info) {
        this.inode = info.ino
        this.deslocamento = info.size
      }
    }
  }

  ler(): Array<string> {
    const info = estatistica(this.caminho)
    if (!info) return []
    if (this.inode !== undefined && info.ino !== this.inode) this.recomecar()
    else if (info.size < this.deslocamento) this.recomecar()
    this.inode = info.ino
    if (info.size === this.deslocamento) return []

    const bytes = lerTrecho(this.caminho, this.deslocamento, info.size - this.deslocamento)
    this.deslocamento += bytes.length
    const texto = this.resto + bytes.toString("utf8")
    const linhas = texto.split("\n")
    this.resto = linhas.pop() ?? ""
    return linhas.filter((l) => l.trim() !== "")
  }

  private recomecar(): void {
    this.deslocamento = 0
    this.resto = ""
  }
}

/** As linhas completas dos últimos `bytes` do arquivo (a primeira, cortada, é descartada). */
export const ultimasLinhas = (caminho: string, bytes = 64 * 1024): Array<string> => {
  const info = estatistica(caminho)
  if (!info || info.size === 0) return []
  const inicio = Math.max(0, info.size - bytes)
  const linhas = lerTrecho(caminho, inicio, info.size - inicio).toString("utf8").split("\n")
  if (inicio > 0) linhas.shift()
  return linhas.filter((l) => l.trim() !== "")
}

const estatistica = (caminho: string) => {
  try {
    const info = statSync(caminho)
    return info.isFile() ? info : undefined
  } catch {
    return undefined
  }
}

const lerTrecho = (caminho: string, inicio: number, tamanho: number): Buffer => {
  const limite = Math.min(tamanho, 8 * 1024 * 1024)
  const fd = openSync(caminho, "r")
  try {
    const buffer = Buffer.alloc(limite)
    const lidos = readSync(fd, buffer, 0, limite, inicio)
    return buffer.subarray(0, lidos)
  } finally {
    closeSync(fd)
  }
}
