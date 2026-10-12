import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { Otlp } from "effect/observability"
import { hostname } from "node:os"

/** Where the OTLP/HTTP collector listens: the jarvis-telemetria container on this Mac. */
export const DEFAULT_OTLP_URL = "http://127.0.0.1:4318"

/**
 * `JARVIS_OTLP_URL` (default `http://127.0.0.1:4318`) and `JARVIS_TELEMETRY`
 * (`0` or `false` turns export off).
 */
export const TelemetryConfig = Config.all({
  url: Config.String("JARVIS_OTLP_URL").pipe(Config.withDefault(DEFAULT_OTLP_URL)),
  enabled: Config.String("JARVIS_TELEMETRY").pipe(
    Config.withDefault("1"),
    Config.map((value) => !["0", "false", "off"].includes(value.trim().toLowerCase()))
  )
})

export interface TelemetryOptions {
  /** `service.name`, such as `jarvis-callback`. */
  readonly serviceName: string
  readonly serviceVersion?: string | undefined
  readonly attributes?: Record<string, unknown> | undefined
}

/**
 * Exports the Effect tracer, metrics and logs over OTLP/HTTP (JSON).
 *
 * Telemetry never takes a service down: a bad configuration turns it off, and
 * an unreachable collector only makes the exporter pause for 60 seconds and
 * drop that batch. The exporter's own requests are never traced.
 */
export const layer = (options: TelemetryOptions): Layer.Layer<never> =>
  Layer.unwrap(
    Effect.gen(function*() {
      const { enabled, url } = yield* TelemetryConfig
      if (!enabled) return Layer.empty
      return Otlp.layerJson({
        baseUrl: url,
        resource: {
          serviceName: options.serviceName,
          serviceVersion: options.serviceVersion,
          attributes: {
            "service.namespace": "jarvis",
            "service.instance.id": `${hostname()}:${process.pid}`,
            "host.name": hostname(),
            "process.pid": process.pid,
            ...options.attributes
          }
        },
        // 15 s: barato para o Mac e ainda "ao vivo" no painel, que atualiza no mesmo ritmo.
        tracerExportInterval: "15 seconds",
        loggerExportInterval: "15 seconds",
        metricsExportInterval: "15 seconds",
        shutdownTimeout: "2 seconds"
      }).pipe(Layer.provide(FetchHttpClient.layer))
    }).pipe(Effect.orElseSucceed(() => Layer.empty))
  )
