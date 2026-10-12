import type { Vitrine } from "./estado.ts"

/**
 * HTTP só em 127.0.0.1: GET /estado devolve o último retrato; GET
 * /estado/ao-vivo é SSE (`event: estado`) com o retrato atual na conexão e um
 * novo a cada coleta, mais um comentário `: vivo` a cada 15 s.
 */
export const criarServidor = (vitrine: Vitrine, opcoes: { readonly porta: number; readonly host?: string }) =>
  Bun.serve({
    hostname: opcoes.host ?? "127.0.0.1",
    port: opcoes.porta,
    idleTimeout: 0,
    fetch: (req) => {
      const url = new URL(req.url)
      const cors = { "access-control-allow-origin": "*", "cache-control": "no-store" }
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors })
      if (req.method !== "GET") return new Response("método não suportado\n", { status: 405, headers: cors })

      if (url.pathname === "/estado") {
        const retrato = vitrine.ultimo()
        if (!retrato) return Response.json({ erro: "primeira coleta ainda em andamento" }, { status: 503, headers: cors })
        return Response.json(retrato, { headers: cors })
      }

      if (url.pathname === "/estado/ao-vivo") {
        const codificador = new TextEncoder()
        let parar = () => {}
        const corpo = new ReadableStream<Uint8Array>({
          start(controle) {
            const enviar = (texto: string) => controle.enqueue(codificador.encode(texto))
            const atual = vitrine.ultimo()
            enviar("retry: 3000\n\n")
            if (atual) enviar(`event: estado\ndata: ${JSON.stringify(atual)}\n\n`)
            const sair = vitrine.ouvir((retrato) => enviar(`event: estado\ndata: ${JSON.stringify(retrato)}\n\n`))
            const batida = setInterval(() => {
              try {
                enviar(": vivo\n\n")
              } catch {
                parar()
              }
            }, 15_000)
            parar = () => {
              clearInterval(batida)
              sair()
            }
            req.signal.addEventListener("abort", () => parar())
          },
          cancel() {
            parar()
          }
        })
        return new Response(corpo, {
          headers: { ...cors, "content-type": "text/event-stream; charset=utf-8", connection: "keep-alive" }
        })
      }

      if (url.pathname === "/" || url.pathname === "/saude") {
        return Response.json({ ok: true, conexoes_ao_vivo: vitrine.conexoes }, { headers: cors })
      }
      return new Response("não encontrado\n", { status: 404, headers: cors })
    }
  })
