import { Context, Effect, Layer, Schema, SchemaTransformation } from "effect"
import { AutomationError } from "./apple-error.ts"
import { Osascript } from "./osascript.ts"

const E164 = /^\+[1-9]\d{7,14}$/

// Spoken or copied numbers often carry spaces, dashes, dots or parentheses,
// sometimes in full-width or other Unicode forms (＋５５, U+2011 hyphen, NBSP).
// NFKC folds compatibility forms to ASCII, then separators are dropped so only
// `+` and ASCII digits reach the URL. A leading `00` is not rewritten to `+`:
// in Brazil `00` is followed by a carrier code, so the guess would be wrong.
export const PhoneNumber = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String.check(
      Schema.isPattern(E164, { expected: "an E.164 phone number such as +5511999998888" })
    ),
    SchemaTransformation.transform({
      decode: (number) => number.normalize("NFKC").replace(/[\s().\p{Pd}]/gu, ""),
      encode: (number) => number
    })
  )
)

export const CallVia = Schema.Literals(["phone", "facetime-audio"])

export const PhoneCallInput = Schema.Struct({
  number: PhoneNumber,
  via: Schema.optionalKey(CallVia)
})

export const PhoneCall = Schema.Struct({
  url: Schema.String
})

const schemes: Record<typeof CallVia.Type, string> = {
  phone: "tel:",
  "facetime-audio": "facetime-audio:"
}

export class Phone extends Context.Service<Phone, {
  call(input: typeof PhoneCallInput.Encoded): Effect.Effect<typeof PhoneCall.Type, AutomationError>
}>()("@jarvis/apple/Phone") {
  static readonly layer = Layer.effect(
    Phone,
    Effect.gen(function*() {
      const osascript = yield* Osascript

      // Opening the URL only hands the number to macOS, which asks the user to
      // confirm before anything is dialed.
      const call = Effect.fn("Phone.call")(function*(input: typeof PhoneCallInput.Encoded) {
        const { number, via = "phone" } = yield* Schema.decodeUnknownEffect(PhoneCallInput)(input).pipe(
          Effect.mapError((error) => new AutomationError({ message: `Invalid phone call request: ${error.message}` }))
        )
        const url = `${schemes[via]}${number}`
        yield* osascript.open(url)
        return PhoneCall.make({ url })
      })

      return Phone.of({ call })
    })
  )
}
