import type { EstadoEscuta } from "./escuta.ts"
import type { EstadoHerdr } from "./herdr.ts"
import type { Servico } from "./servicos.ts"

/** O JSON de GET /estado e de cada evento de /estado/ao-vivo. */
export interface Retrato {
  readonly gerado_em: string
  readonly coletor: {
    readonly pid: number
    readonly desde: string
    readonly intervalo_s: number
    readonly otlp: string
  }
  readonly escuta: EstadoEscuta
  readonly herdr: EstadoHerdr
  readonly servicos: ReadonlyArray<Servico>
}

type Ouvinte = (retrato: Retrato) => void

/** Guarda o último retrato e avisa quem está ouvindo (as conexões SSE). */
export class Vitrine {
  private atual: Retrato | undefined
  private readonly ouvintes = new Set<Ouvinte>()

  ultimo(): Retrato | undefined {
    return this.atual
  }

  publicar(retrato: Retrato): void {
    this.atual = retrato
    for (const ouvinte of this.ouvintes) {
      try {
        ouvinte(retrato)
      } catch {
        this.ouvintes.delete(ouvinte)
      }
    }
  }

  ouvir(ouvinte: Ouvinte): () => void {
    this.ouvintes.add(ouvinte)
    return () => this.ouvintes.delete(ouvinte)
  }

  get conexoes(): number {
    return this.ouvintes.size
  }
}
