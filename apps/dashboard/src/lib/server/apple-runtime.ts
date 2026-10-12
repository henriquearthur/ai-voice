import { NodeServices } from '@effect/platform-node';
import { Calendar, Maps, Osascript, Phone, Reminders } from '@jarvis/apple';
import { Layer, ManagedRuntime } from 'effect';
import { memoMap, TelemetryLive } from './telemetry.js';

const AppleLive: Layer.Layer<Reminders | Calendar | Maps | Phone | Osascript> = Layer.mergeAll(Reminders.layer, Calendar.layer, Maps.layer, Phone.layer).pipe(
	Layer.provideMerge(Osascript.layer),
	Layer.provide(NodeServices.layer)
);

/** The Effect runtime for the macOS apps (Reminders, Calendar, Maps, Phone), all driven through osascript. */
export const appleRuntime = ManagedRuntime.make(Layer.merge(AppleLive, TelemetryLive), { memoMap });

/** The services an effect handed to `runApple` may use. */
export type AppleServices = Reminders | Calendar | Maps | Phone | Osascript;

// Vite re-evaluates this module on edit; dispose the old runtime so its scope (and any child process) closes.
import.meta.hot?.dispose(() => appleRuntime.dispose());
