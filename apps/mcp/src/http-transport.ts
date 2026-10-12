import { BunHttpServer } from "@effect/platform-bun"
import { Console, Effect, Layer } from "effect"
import { McpServer } from "effect/ai"
import { HttpRouter, HttpServer } from "effect/http"
import { name, serverOptions, VoiceTools } from "./server.ts"

export const path = "/mcp"

/**
 * Registers the Streamable HTTP MCP endpoint on the `HttpRouter`.
 *
 * `McpServer.layerHttp` refuses any request carrying `Origin` (no origins are
 * allowed), so a web page open in a browser cannot reach the endpoint.
 * Only the voice tools are served: without authentication, the Apple tools
 * (reminders, calendar, phone_call) stay on stdio.
 */
export const McpRoutes = Layer.unwrap(Effect.map(serverOptions, (options) =>
  // DELETE ends a session, as clients do when they disconnect; sessions never expire otherwise.
  VoiceTools.pipe(Layer.provide(McpServer.layerHttp({ ...options, path, allowSessionTermination: true })))
))

/**
 * Serves MCP on `/mcp` for agents on other machines.
 *
 * There is no authentication: bind only to loopback or a private interface.
 */
export const HttpTransport = (options: { readonly hostname: string; readonly port: number }) =>
  HttpRouter.serve(McpRoutes, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.merge(Layer.effectDiscard(
      HttpServer.addressFormattedWith((url) => Console.error(`${name} listening on ${url}${path}`))
    )),
    Layer.provide(BunHttpServer.layerServer(options))
  )
