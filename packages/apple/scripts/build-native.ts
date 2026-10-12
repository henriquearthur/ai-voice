// Compiles the EventKit Calendar helper into the cache outside the repository
// (`~/.local/share/jarvis/bin`, or `$JARVIS_BIN_DIR`) and links it as
// `calendar-events` there. The Calendar service also compiles on first use, but
// a bundled server (the installed dashboard) has no sources and needs this link.
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { installHelper } from "../src/calendar-helper.ts"

const program = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const path = yield* installHelper(spawner)
  yield* Effect.log(`Calendar helper: ${path}`)
})

Effect.runPromise(program.pipe(Effect.provide(BunServices.layer))).catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
