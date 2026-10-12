/**
 * Eventos da Escuta (uma linha JSON por evento em escuta.events.jsonl) e o
 * resumo que o /estado mostra. Tudo aqui é puro: o tail e as métricas ficam
 * em tail.ts e metricas.ts.
 */

export interface EventoEscuta {
  readonly type: string
  readonly ts: string
  readonly [campo: string]: unknown
}

export const parseLinha = (linha: string): EventoEscuta | undefined => {
  const texto = linha.trim()
  if (texto === "") return undefined
  try {
    const valor: unknown = JSON.parse(texto)
    if (typeof valor !== "object" || valor === null) return undefined
    const { type, ts } = valor as Record<string, unknown>
    if (typeof type !== "string" || type === "") return undefined
    return { ...(valor as Record<string, unknown>), type, ts: typeof ts === "string" ? ts : new Date().toISOString() }
  } catch {
    return undefined
  }
}

export const numero = (valor: unknown): number | undefined =>
  typeof valor === "number" && Number.isFinite(valor) ? valor : undefined

export const texto = (valor: unknown, padrao: string): string =>
  typeof valor === "string" && valor.trim() !== "" ? valor.trim() : padrao

export const booleano = (valor: unknown): boolean => valor === true

/** Janela deslizante das últimas N amostras de uma medida. */
export class Janela {
  private readonly valores: Array<number> = []
  constructor(private readonly tamanho = 100) {}

  add(valor: number): void {
    this.valores.push(valor)
    if (this.valores.length > this.tamanho) this.valores.shift()
  }

  resumo(): ResumoMedida {
    const n = this.valores.length
    if (n === 0) return { amostras: 0, ultima: null, media: null, p50: null, p95: null, maxima: null }
    const ordenados = [...this.valores].sort((a, b) => a - b)
    const quantil = (q: number) => ordenados[Math.min(n - 1, Math.ceil(q * n) - 1)]!
    const arredonda = (v: number) => Math.round(v * 1000) / 1000
    return {
      amostras: n,
      ultima: arredonda(this.valores[n - 1]!),
      media: arredonda(this.valores.reduce((s, v) => s + v, 0) / n),
      p50: arredonda(quantil(0.5)),
      p95: arredonda(quantil(0.95)),
      maxima: arredonda(ordenados[n - 1]!)
    }
  }
}

export interface ResumoMedida {
  readonly amostras: number
  readonly ultima: number | null
  readonly media: number | null
  readonly p50: number | null
  readonly p95: number | null
  readonly maxima: number | null
}

export interface Contadores {
  ouvidos: number
  descartadas: number
  pedidos: number
  entregues: number
  falhas: number
  interrupcoes: number
  reinicios_reconhecimento: number
  reinicios_escuta: number
  erros: number
}

export type Fase = "desconhecida" | "ouvindo" | "jarvis_falando" | "pausada" | "parada"

export interface EstadoEscuta {
  readonly arquivo: string
  readonly desde: string
  readonly ultimo_evento_em: string | null
  readonly fase: Fase
  readonly microfone: string | null
  readonly saida: string | null
  readonly contadores: Contadores
  readonly entrega_ms: ResumoMedida
  /** Fim da fala até o pedido chegar (routed com ok); semeado com o histórico do arquivo. */
  readonly latencia_fim_fala_ms: ResumoMedida
  readonly roteamento_ms: ResumoMedida
  readonly interrupcao_kill_ms: ResumoMedida
  readonly confianca: ResumoMedida
  readonly ultimos_eventos: ReadonlyArray<Record<string, unknown>>
}

const MAX_TEXTO = 160
const MAX_EVENTOS = 20

/** Versão curta do evento para o /estado: sem a lista de processos mortos e com texto cortado. */
export const resumirEvento = (evento: EventoEscuta): Record<string, unknown> => {
  const { killed: _killed, ...resto } = evento
  const saida: Record<string, unknown> = {}
  for (const [chave, valor] of Object.entries(resto)) {
    saida[chave] = typeof valor === "string" && valor.length > MAX_TEXTO ? `${valor.slice(0, MAX_TEXTO)}…` : valor
  }
  return saida
}

/**
 * Acumula o que a Escuta contou. Contadores e medidas valem desde que o
 * coletor subiu; `semear` preenche fase, microfone e últimos eventos com o
 * histórico do arquivo, sem contar nada, e só semeia a janela de
 * latencia_fim_fala_ms (que assim já tem p50/p95 ao subir). Semeado e
 * aplicado nunca se cruzam: o seguidor começa no fim do arquivo.
 */
export class ResumoEscuta {
  private readonly desde = new Date().toISOString()
  private ultimoEvento: string | null = null
  private fase: Fase = "desconhecida"
  private microfone: string | null = null
  private saida: string | null = null
  private readonly contadores: Contadores = {
    ouvidos: 0,
    descartadas: 0,
    pedidos: 0,
    entregues: 0,
    falhas: 0,
    interrupcoes: 0,
    reinicios_reconhecimento: 0,
    reinicios_escuta: 0,
    erros: 0
  }
  private readonly entrega = new Janela()
  private readonly fimFala = new Janela()
  private readonly roteamento = new Janela()
  private readonly killMs = new Janela()
  private readonly confianca = new Janela()
  private readonly eventos: Array<Record<string, unknown>> = []

  constructor(private readonly arquivo: string) {}

  semear(evento: EventoEscuta): void {
    this.aplicarEstado(evento)
    this.medirFimFala(evento)
  }

  private medirFimFala(evento: EventoEscuta): void {
    if (evento.type !== "routed" || !booleano(evento.ok)) return
    const latencia = numero(evento.latency_ms)
    if (latencia !== undefined && latencia >= 0) this.fimFala.add(latencia)
  }

  aplicar(evento: EventoEscuta): void {
    this.aplicarEstado(evento)
    const c = this.contadores
    switch (evento.type) {
      case "heard": {
        c.ouvidos++
        if (!booleano(evento.sent)) c.descartadas++
        const conf = numero(evento.confidence)
        if (conf !== undefined && conf >= 0) this.confianca.add(conf)
        break
      }
      case "routed": {
        c.pedidos++
        if (booleano(evento.ok)) c.entregues++
        else c.falhas++
        const latencia = numero(evento.latency_ms)
        if (latencia !== undefined) this.entrega.add(latencia)
        this.medirFimFala(evento)
        const ms = numero(evento.ms)
        if (ms !== undefined) this.roteamento.add(ms)
        break
      }
      case "barge_in": {
        c.interrupcoes++
        const kill = numero(evento.kill_ms)
        if (kill !== undefined) this.killMs.add(kill)
        break
      }
      case "recognizer":
        c.reinicios_reconhecimento++
        break
      case "restart":
        c.reinicios_escuta++
        break
      case "error":
        c.erros++
        break
    }
  }

  private aplicarEstado(evento: EventoEscuta): void {
    this.ultimoEvento = evento.ts
    switch (evento.type) {
      case "ready":
        this.microfone = texto(evento.mic, "") || this.microfone
        this.fase = "ouvindo"
        break
      case "airpods":
        this.saida = texto(evento.device, "") || this.saida
        break
      case "jarvis_speaking":
        this.fase = "jarvis_falando"
        break
      case "jarvis_quiet":
      case "resumed":
        this.fase = "ouvindo"
        break
      case "paused":
        this.fase = "pausada"
        break
      case "stopped":
        this.fase = "parada"
        break
    }
    this.eventos.push(resumirEvento(evento))
    if (this.eventos.length > MAX_EVENTOS) this.eventos.shift()
  }

  estado(): EstadoEscuta {
    return {
      arquivo: this.arquivo,
      desde: this.desde,
      ultimo_evento_em: this.ultimoEvento,
      fase: this.fase,
      microfone: this.microfone,
      saida: this.saida,
      contadores: { ...this.contadores },
      entrega_ms: this.entrega.resumo(),
      latencia_fim_fala_ms: this.fimFala.resumo(),
      roteamento_ms: this.roteamento.resumo(),
      interrupcao_kill_ms: this.killMs.resumo(),
      confianca: this.confianca.resumo(),
      ultimos_eventos: [...this.eventos].reverse()
    }
  }
}
