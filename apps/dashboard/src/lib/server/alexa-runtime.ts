import { NodeServices } from '@effect/platform-node';
import { Alexa, AlexaConfig } from '@jarvis/alexa';
import { MacVoice, MacVoiceConfig } from '@jarvis/voice';
import { Layer, ManagedRuntime } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { memoMap, TelemetryLive } from './telemetry.js';

const Platform = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);

const AlexaLive = Alexa.layer.pipe(Layer.provideMerge(AlexaConfig.layer));
const MacVoiceLive = MacVoice.layer.pipe(Layer.provideMerge(MacVoiceConfig.layer));

/**
 * The one Effect runtime of the dashboard: the Mac voice (the default output) and the authenticated
 * Alexa connection, both kept between requests.
 */
export const alexaRuntime = ManagedRuntime.make(
	Layer.mergeAll(AlexaLive, MacVoiceLive).pipe(Layer.provide(Platform), Layer.merge(TelemetryLive)),
	{ memoMap }
);

// Vite re-evaluates this module on edit; release the old connection instead of leaking it.
import.meta.hot?.dispose(() => alexaRuntime.dispose());
