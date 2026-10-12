import { createHash } from "node:crypto"
import { Context, DateTime, Effect, FileSystem, Layer, Option, Path } from "effect"
import { AnnounceConfig } from "./announce-config.ts"
import { DEDUP_WINDOW_MS, loadState, pruneState, RATE_WINDOW_MS, saveState } from "./announce-state.ts"
import { type AnnounceInput, compose, type ContentSkipReason } from "./compose.ts"
import { isQuietAt } from "./quiet-hours.ts"

export type SkipReason = ContentSkipReason | "quiet-hours" | "duplicate" | "rate-limited"

export type Decision =
  | { readonly _tag: "speak"; readonly text: string }
  | { readonly _tag: "skip"; readonly reason: SkipReason }

const skip = (reason: SkipReason): Decision => ({ _tag: "skip", reason })

/** Same content after normalization (case, accents, punctuation, spacing) hashes the same. */
export const contentHash = (text: string): string =>
  createHash("sha256")
    .update(
      text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
    )
    .digest("hex")
    .slice(0, 32)

const make = Effect.gen(function*() {
  const config = yield* AnnounceConfig
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const provide = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path))

  const decide = Effect.fn("Announcer.decide")(function*(input: AnnounceInput) {
    const composed = compose(input)
    if (composed._tag === "skip") return skip(composed.reason)

    const now = yield* DateTime.now
    if (Option.isSome(config.quietHours) && isQuietAt(config.quietHours.value, now, config.timeZone)) {
      return skip("quiet-hours")
    }

    const millis = DateTime.toEpochMillis(now)
    const hash = contentHash(composed.text)
    const state = pruneState(yield* provide(loadState(config.stateDir)), millis)
    if (state.spoken.some((entry) => entry.hash === hash && entry.at > millis - DEDUP_WINDOW_MS)) {
      return skip("duplicate")
    }
    if (state.spoken.filter((entry) => entry.at > millis - RATE_WINDOW_MS).length >= config.maxPerMinute) {
      return skip("rate-limited")
    }

    // A state that cannot be saved must not silence the notification.
    const next = pruneState({ ...state, spoken: [...state.spoken, { hash, at: millis }] }, millis)
    yield* provide(saveState(config.stateDir, next)).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Could not save the announce state.", cause))
    )
    return { _tag: "speak", text: composed.text } satisfies Decision
  })

  return { decide }
})

/**
 * Decides whether a notification should be spoken and how, in pt-BR. It never
 * speaks: the caller hands a `speak` decision to `Alexa.speak`.
 */
export class Announcer extends Context.Service<Announcer, {
  readonly decide: (input: AnnounceInput) => Effect.Effect<Decision>
}>()("@jarvis/announce/Announcer", { make }) {
  static readonly layer: Layer.Layer<Announcer, never, AnnounceConfig | FileSystem.FileSystem | Path.Path> = Layer
    .effect(Announcer, Announcer.make)
}
