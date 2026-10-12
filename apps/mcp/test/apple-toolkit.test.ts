import { assert, describe, expectTypeOf, it } from "@effect/vitest"
import { AutomationError, Calendar, type CalendarEvent, Maps, Phone, type Reminder, Reminders } from "@jarvis/apple"
import { Effect, Layer } from "effect"
import { McpSchema, McpServer } from "effect/ai"
import type { ChildProcessSpawner } from "effect/process"
import { AppleToolkitLayer, layer } from "../src/apple-toolkit.ts"

const reminder: Reminder = {
  id: "x-apple-reminder://1",
  title: "Buy milk",
  list: "Groceries",
  completed: false,
  due: "2026-10-12"
}

const event: CalendarEvent = {
  id: "event-1",
  title: "Standup",
  calendar: "Work",
  start: "2026-10-11T09:00:00.000-03:00",
  end: "2026-10-11T09:15:00.000-03:00",
  allDay: false
}

const denied = new AutomationError({ message: "macOS denied Automation permission." })

// Every service is faked: the real ones would show macOS prompts, open Maps or dial.
const makeFakes = (options: { readonly failAdd?: boolean } = {}) => {
  const calls: Array<readonly [string, unknown]> = []
  const record = <A>(name: string, input: unknown, result: A) =>
    Effect.sync(() => {
      calls.push([name, input])
      return result
    })
  const layer = Layer.mergeAll(
    Layer.succeed(
      Reminders,
      Reminders.of({
        lists: Effect.succeed(["Groceries", "Work"]),
        list: (input) => record("reminders.list", input, [reminder]),
        add: (input) => options.failAdd === true ? Effect.fail(denied) : record("reminders.add", input, reminder)
      })
    ),
    Layer.succeed(
      Calendar,
      Calendar.of({
        calendars: Effect.succeed(["Work"]),
        events: (input) => record("calendar.events", input, [event]),
        today: Effect.succeed([event])
      })
    ),
    Layer.succeed(
      Maps,
      Maps.of({
        search: (input) => record("maps.search", input, { url: "https://maps.apple.com/?q=cafe" }),
        directions: (input) => record("maps.directions", input, { url: "https://maps.apple.com/?daddr=home" })
      })
    ),
    Layer.succeed(
      Phone,
      Phone.of({ call: (input) => record("phone.call", input, { url: "tel:+5511999998888" }) })
    )
  )
  return { calls, layer }
}

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "apple-toolkit-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "apple-toolkit-test", version: "1.0.0" }
  },
  getClient: Effect.die("not used")
})

const serve = (fakes: Layer.Layer<Reminders | Calendar | Maps | Phone>) =>
  Layer.provideMerge(AppleToolkitLayer.pipe(Layer.provide(fakes)), McpServer.McpServer.layer)

const listTools = Effect.map(McpServer.McpServer, (server) => server.tools.map(({ tool }) => tool))

const callTool = (name: string, args: Record<string, unknown> = {}) =>
  McpServer.McpServer.use((server) => server.callTool({ name, arguments: args })).pipe(
    Effect.provideService(McpSchema.McpServerClient, client)
  )

describe("AppleToolkit", () => {
  it("needs only a ChildProcessSpawner when backed by the real services", () => {
    expectTypeOf(layer).toEqualTypeOf<Layer.Layer<never, never, ChildProcessSpawner.ChildProcessSpawner>>()
  })

  it.effect("lists the tools with their MCP annotations", () =>
    Effect.gen(function*() {
      const tools = yield* listTools
      const annotations = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]))
      const readLocal = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
      const showInMaps = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      assert.deepStrictEqual(annotations, {
        reminders_lists: readLocal,
        reminders_list: readLocal,
        reminders_add: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        calendar_today: readLocal,
        calendar_events: readLocal,
        calendar_calendars: readLocal,
        maps_search: showInMaps,
        maps_directions: showInMaps,
        phone_call: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
      })
    }).pipe(Effect.provide(serve(makeFakes().layer))))

  it.effect("exposes snake_case input schemas", () =>
    Effect.gen(function*() {
      const tools = yield* listTools
      const input = (name: string) => {
        const schema = tools.find((tool) => tool.name === name)?.inputSchema as {
          readonly type: string
          readonly properties?: Record<string, { readonly type?: string; readonly enum?: ReadonlyArray<string> }>
          readonly required?: ReadonlyArray<string>
        }
        return {
          type: schema.type,
          properties: Object.keys(schema.properties ?? {}),
          required: schema.required ?? []
        }
      }
      assert.deepStrictEqual(input("reminders_lists"), { type: "object", properties: [], required: [] })
      assert.deepStrictEqual(input("reminders_list"), {
        type: "object",
        properties: ["list", "include_completed"],
        required: []
      })
      assert.deepStrictEqual(input("reminders_add"), {
        type: "object",
        properties: ["title", "list", "due", "notes"],
        required: ["title"]
      })
      assert.deepStrictEqual(input("calendar_events"), {
        type: "object",
        properties: ["from", "to", "calendar"],
        required: ["from", "to"]
      })
      assert.deepStrictEqual(input("maps_directions"), {
        type: "object",
        properties: ["to", "from", "mode"],
        required: ["to"]
      })
      assert.deepStrictEqual(input("phone_call"), {
        type: "object",
        properties: ["number", "via"],
        required: ["number"]
      })
    }).pipe(Effect.provide(serve(makeFakes().layer))))

  it.effect("warns agents to place calls only on explicit request", () =>
    Effect.gen(function*() {
      const tools = yield* listTools
      const description = tools.find((tool) => tool.name === "phone_call")?.description ?? ""
      assert.match(description, /macOS shows its own confirmation/)
      assert.match(description, /only call this when the user explicitly asked/i)
    }).pipe(Effect.provide(serve(makeFakes().layer))))

  it.effect("maps snake_case arguments onto the services", () => {
    const { calls, layer } = makeFakes()
    return Effect.gen(function*() {
      yield* callTool("reminders_list", { list: "Groceries", include_completed: true })
      yield* callTool("reminders_add", { title: "Buy milk", due: "2026-10-12" })
      yield* callTool("calendar_events", { from: "2026-10-11T00:00:00Z", to: "2026-10-12T00:00:00Z" })
      yield* callTool("maps_search", { query: "cafe" })
      yield* callTool("maps_directions", { to: "home", mode: "walking" })
      yield* callTool("phone_call", { number: "+5511999998888", via: "facetime-audio" })
      assert.deepStrictEqual(calls, [
        ["reminders.list", { list: "Groceries", includeCompleted: true }],
        ["reminders.add", { title: "Buy milk", due: "2026-10-12" }],
        ["calendar.events", { from: "2026-10-11T00:00:00Z", to: "2026-10-12T00:00:00Z" }],
        ["maps.search", { query: "cafe" }],
        ["maps.directions", { to: "home", mode: "walking" }],
        ["phone.call", { number: "+5511999998888", via: "facetime-audio" }]
      ])
    }).pipe(Effect.provide(serve(layer)))
  })

  it.effect("returns results as structured content with snake_case fields", () =>
    Effect.gen(function*() {
      const lists = yield* callTool("reminders_lists")
      assert.strictEqual(lists.isError, false)
      assert.deepStrictEqual(lists.content, [{ type: "text", text: JSON.stringify(["Groceries", "Work"]) }])

      const today = yield* callTool("calendar_today")
      assert.strictEqual(today.isError, false)
      assert.deepStrictEqual(today.structuredContent, [{
        id: "event-1",
        title: "Standup",
        calendar: "Work",
        start: "2026-10-11T09:00:00.000-03:00",
        end: "2026-10-11T09:15:00.000-03:00",
        all_day: false
      }])
    }).pipe(Effect.provide(serve(makeFakes().layer))))

  it.effect("surfaces AutomationError as an error result with its message", () =>
    Effect.gen(function*() {
      const result = yield* callTool("reminders_add", { title: "Buy milk" })
      assert.strictEqual(result.isError, true)
      assert.deepStrictEqual(result.content, [{ type: "text", text: denied.message }])
    }).pipe(Effect.provide(serve(makeFakes({ failAdd: true }).layer))))
})
