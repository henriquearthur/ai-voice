import { Context, Effect, Layer, Schema } from "effect"
import { AutomationError } from "./apple-error.ts"
import { Osascript } from "./osascript.ts"

const MAPS_URL = "https://maps.apple.com/"

const Place = Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(500))

export const MapsSearchInput = Schema.Struct({
  query: Place
})

export const TravelMode = Schema.Literals(["driving", "walking", "transit"])

export const MapsDirectionsInput = Schema.Struct({
  to: Place,
  from: Schema.optionalKey(Place),
  mode: Schema.optionalKey(TravelMode)
})

export const MapsLink = Schema.Struct({
  url: Schema.String
})

const directionFlags: Record<typeof TravelMode.Type, string> = {
  driving: "d",
  walking: "w",
  transit: "r"
}

const mapsUrl = (params: URLSearchParams): string => `${MAPS_URL}?${params.toString()}`

const decodeInput = <S extends Schema.Decoder<unknown>>(schema: S) => (input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError((error) => new AutomationError({ message: `Invalid Maps request: ${error.message}` }))
  )

export class Maps extends Context.Service<Maps, {
  search(input: typeof MapsSearchInput.Encoded): Effect.Effect<typeof MapsLink.Type, AutomationError>
  directions(input: typeof MapsDirectionsInput.Encoded): Effect.Effect<typeof MapsLink.Type, AutomationError>
}>()("@jarvis/apple/Maps") {
  static readonly layer = Layer.effect(
    Maps,
    Effect.gen(function*() {
      const osascript = yield* Osascript

      const show = Effect.fnUntraced(function*(params: URLSearchParams) {
        const url = mapsUrl(params)
        yield* osascript.open(url)
        return MapsLink.make({ url })
      })

      const search = Effect.fn("Maps.search")(function*(input: typeof MapsSearchInput.Encoded) {
        const { query } = yield* decodeInput(MapsSearchInput)(input)
        return yield* show(new URLSearchParams({ q: query }))
      })

      const directions = Effect.fn("Maps.directions")(function*(input: typeof MapsDirectionsInput.Encoded) {
        const { from, mode, to } = yield* decodeInput(MapsDirectionsInput)(input)
        const params = new URLSearchParams()
        if (from !== undefined) params.set("saddr", from)
        params.set("daddr", to)
        if (mode !== undefined) params.set("dirflg", directionFlags[mode])
        return yield* show(params)
      })

      return Maps.of({ search, directions })
    })
  )
}
