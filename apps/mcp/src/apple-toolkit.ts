import { observeTools } from "@jarvis/telemetry"
import {
  AutomationError,
  Calendar,
  CalendarEvent,
  CallVia,
  Maps,
  MapsLink,
  Osascript,
  Phone,
  PhoneCall,
  Reminder,
  Reminders,
  TravelMode
} from "@jarvis/apple"
import { Context, Effect, Layer, Schema } from "effect"
import { McpServer, Tool, Toolkit } from "effect/ai"

const text = (description: string) => Schema.String.annotate({ description })

const IsoDateTime = text(
  "ISO 8601 date-time, preferably with an offset, e.g. 2026-10-11T09:00:00-03:00."
)

// Reminders and Calendar only touch the user's own data on this Mac.
const ReadLocal = Context.make(Tool.Readonly, true).pipe(
  Context.add(Tool.Destructive, false),
  Context.add(Tool.OpenWorld, false)
)

const RemindersLists = Tool.make("reminders_lists", {
  description: "Lists the names of the Reminders lists.",
  success: Schema.Array(Schema.String),
  failure: AutomationError
}).annotateMerge(ReadLocal)

const RemindersList = Tool.make("reminders_list", {
  description: "Lists reminders, open ones only unless include_completed is true. " +
    "Timed due dates carry the Mac's UTC offset; all-day ones are YYYY-MM-DD.",
  parameters: Schema.Struct({
    list: Schema.optionalKey(text("Reminders list name. Omit to read every list.")),
    includeCompleted: Schema.optionalKey(
      Schema.Boolean.annotate({ description: "Also return completed reminders. Defaults to false." })
    )
  }).pipe(Schema.encodeKeys({ includeCompleted: "include_completed" })),
  success: Schema.Array(Reminder),
  failure: AutomationError
}).annotateMerge(ReadLocal)

const RemindersAdd = Tool.make("reminders_add", {
  description: "Creates a reminder and returns it.",
  parameters: Schema.Struct({
    title: text("Reminder title."),
    list: Schema.optionalKey(text("Reminders list name. Omit to use the default list.")),
    due: Schema.optionalKey(text(
      "ISO 8601 due date: YYYY-MM-DD for all day, or a date-time such as 2026-10-11T09:30 " +
        "(Mac local time) or 2026-10-11T09:30-03:00."
    )),
    notes: Schema.optionalKey(text("Free-text notes."))
  }),
  success: Reminder,
  failure: AutomationError
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)

const Event = CalendarEvent.pipe(Schema.encodeKeys({ allDay: "all_day" }))

const CalendarToday = Tool.make("calendar_today", {
  description: "Lists today's events across all calendars, in the Mac's time zone, ordered by start.",
  success: Schema.Array(Event),
  failure: AutomationError
}).annotateMerge(ReadLocal)

const CalendarEvents = Tool.make("calendar_events", {
  description: "Lists events overlapping [from, to), ordered by start. The range may span at most 31 days.",
  parameters: Schema.Struct({
    from: IsoDateTime,
    to: IsoDateTime,
    calendar: Schema.optionalKey(text("Calendar name. Omit to search every calendar."))
  }),
  success: Schema.Array(Event),
  failure: AutomationError
}).annotateMerge(ReadLocal)

const CalendarCalendars = Tool.make("calendar_calendars", {
  description: "Lists the names of the calendars.",
  success: Schema.Array(Schema.String),
  failure: AutomationError
}).annotateMerge(ReadLocal)

// Opening Maps changes what is on screen, so these are not read-only, but
// repeating a call just shows the same place or route again.
const ShowInMaps = Context.make(Tool.Readonly, false).pipe(
  Context.add(Tool.Destructive, false),
  Context.add(Tool.Idempotent, true),
  Context.add(Tool.OpenWorld, true)
)

const MapsSearch = Tool.make("maps_search", {
  description: "Opens Apple Maps on the Mac searching for a place or address, and returns the Maps URL.",
  parameters: Schema.Struct({
    query: text("Place, business or address to search for.")
  }),
  success: MapsLink,
  failure: AutomationError
}).annotateMerge(ShowInMaps)

const MapsDirections = Tool.make("maps_directions", {
  description: "Opens Apple Maps on the Mac with directions, and returns the Maps URL.",
  parameters: Schema.Struct({
    to: text("Destination place or address."),
    from: Schema.optionalKey(text("Starting place or address. Omit to start from the current location.")),
    mode: Schema.optionalKey(TravelMode.annotate({ description: "Travel mode. Defaults to driving." }))
  }),
  success: MapsLink,
  failure: AutomationError
}).annotateMerge(ShowInMaps)

const PhoneCallTool = Tool.make("phone_call", {
  description: "Starts a phone or FaceTime audio call from the Mac. macOS shows its own confirmation " +
    "before dialing. Only call this when the user explicitly asked to call this number.",
  parameters: Schema.Struct({
    number: text("E.164 phone number, e.g. +5511999998888. Spaces, dashes, dots and parentheses are ignored."),
    via: Schema.optionalKey(CallVia.annotate({ description: "How to place the call. Defaults to phone." }))
  }),
  success: PhoneCall,
  failure: AutomationError
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)

/**
 * Reminders, Calendar, Maps and Phone tools backed by `@jarvis/apple`.
 */
export const AppleToolkit = Toolkit.make(
  RemindersLists,
  RemindersList,
  RemindersAdd,
  CalendarToday,
  CalendarEvents,
  CalendarCalendars,
  MapsSearch,
  MapsDirections,
  PhoneCallTool
)

/**
 * Binds the Apple tools to the `@jarvis/apple` services.
 */
export const AppleToolkitHandlers = AppleToolkit.toLayer(Effect.gen(function*() {
  const reminders = yield* Reminders
  const calendar = yield* Calendar
  const maps = yield* Maps
  const phone = yield* Phone
  return AppleToolkit.of(observeTools("mcp", {
    reminders_lists: () => reminders.lists,
    reminders_list: (input) => reminders.list(input),
    reminders_add: (input) => reminders.add(input),
    calendar_today: () => calendar.today,
    calendar_events: (input) => calendar.events(input),
    calendar_calendars: () => calendar.calendars,
    maps_search: (input) => maps.search(input),
    maps_directions: (input) => maps.directions(input),
    phone_call: (input) => phone.call(input)
  }))
}))

/**
 * Registers the Apple tools on whichever `McpServer` transport is provided.
 */
export const AppleToolkitLayer = McpServer.toolkit(AppleToolkit).pipe(Layer.provide(AppleToolkitHandlers))

/**
 * `AppleToolkitLayer` backed by the real services, which drive the Mac's apps
 * through `osascript` and `open`.
 */
export const layer = AppleToolkitLayer.pipe(
  Layer.provide(Layer.mergeAll(Reminders.layer, Calendar.layer, Maps.layer, Phone.layer)),
  Layer.provide(Osascript.layer)
)
