import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { Otlp } from "effect/observability"
import { hostname } from "node:os"

/** `JARVIS_OTLP_URL` (padrão http://127.0.0.1:4318) e `JARVIS_TELEMETRY` (0/false/off desliga). */
export const TelemetriaConfig = Config.all({
  url: Config.String("JARVIS_OTLP_URL").pipe(Config.withDefault("http://127.0.0.1:4318")),
  ligada: Config.String("JARVIS_TELEMETRY").pipe(
    Config.withDefault("1"),
    Config.map((v) => !["0", "false", "off"].includes(v.trim().toLowerCase()))
  )
})

/**
 * Exportador OTLP/HTTP (JSON) de métricas, traces e logs. Com o backend fora
 * do ar o exportador só descarta o lote; o coletor segue servindo o /estado.
 */
export const telemetria = (opcoes: { readonly serviceName: string; readonly serviceVersion: string }) =>
  Layer.unwrap(
    Effect.gen(function*() {
      const { ligada, url } = yield* TelemetriaConfig
      if (!ligada) return Layer.empty
      return Otlp.layerJson({
        baseUrl: url,
        resource: {
          serviceName: opcoes.serviceName,
          serviceVersion: opcoes.serviceVersion,
          attributes: {
            "service.namespace": "jarvis",
            "service.instance.id": `${hostname()}:${process.pid}`,
            "host.name": hostname()
          }
        },
        metricsExportInterval: "5 seconds",
        tracerExportInterval: "5 seconds",
        loggerExportInterval: "5 seconds",
        shutdownTimeout: "2 seconds"
      }).pipe(Layer.provide(FetchHttpClient.layer))
    }).pipe(Effect.orElseSucceed(() => Layer.empty))
  )
