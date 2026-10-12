import { Alexa, AlexaConfig, type AlexaError, type Echo, speechDisabled } from '@jarvis/alexa';
import { MacVoice, MacVoiceConfig, type MacVoiceError } from '@jarvis/voice';
import { Cause, Effect, Exit, Option } from 'effect';
import type { AlexaFailure, MacVoiceStatus, Outcome, SpeechReceipt } from '#lib/alexa/failure.js';
import { alexaRuntime } from './alexa-runtime.js';

export type AlexaSettings = {
	readonly speechEnabled: boolean;
	readonly defaultDevice: string | null;
};

type SpeakError = AlexaError | MacVoiceError;

const kinds = {
	SessionError: 'session',
	DeviceError: 'device',
	SpeechError: 'speech',
	MacVoiceError: 'voice'
} as const satisfies Record<SpeakError['_tag'], AlexaFailure['kind']>;

const toFailure = (cause: Cause.Cause<unknown>): AlexaFailure => {
	const error = Cause.findErrorOption(cause);
	if (Option.isSome(error)) {
		const value = error.value;
		if (isSpeakError(value)) return { kind: kinds[value._tag], message: value.message };
		if (isConfigError(value)) {
			return { kind: 'config', message: 'As variáveis AI_VOICE_* não puderam ser lidas.' };
		}
	}
	// Defects can carry cookies or tokens from the Amazon client: log them here, never send them.
	console.error(Cause.pretty(cause));
	return { kind: 'unexpected', message: 'Algo falhou no servidor. Veja o terminal do dashboard.' };
};

const isSpeakError = (value: unknown): value is SpeakError =>
	typeof value === 'object' && value !== null && '_tag' in value && Object.hasOwn(kinds, value._tag as string);

const isConfigError = (value: unknown) =>
	typeof value === 'object' && value !== null && '_tag' in value && value._tag === 'ConfigError';

type Services = Alexa | AlexaConfig | MacVoice | MacVoiceConfig;

const run = async <A>(effect: Effect.Effect<A, SpeakError, Services>): Promise<Outcome<A>> => {
	const exit = await alexaRuntime.runPromiseExit(effect);
	return Exit.isSuccess(exit) ? { ok: true, value: exit.value } : { ok: false, failure: toFailure(exit.cause) };
};

export const readSettings = () =>
	run(
		AlexaConfig.useSync(
			(config): AlexaSettings => ({
				speechEnabled: config.speechEnabled,
				defaultDevice: Option.getOrNull(config.defaultDevice)
			})
		)
	);

export const listDevices = (): Promise<Outcome<ReadonlyArray<Echo>>> => run(Alexa.use((alexa) => alexa.devices));

// The Kokoro server answers /health in a few milliseconds; past this it would not beat `say` anyway.
const HEALTH_TIMEOUT_MS = 1500;

const kokoroAnswers = async (url: string) => {
	try {
		const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS), redirect: 'manual' });
		if (!response.ok) return false;
		const body: unknown = await response.json();
		return typeof body === 'object' && body !== null && 'status' in body && body.status === 'ok';
	} catch {
		return false;
	}
};

/** Which engine the next sentence on the Mac will use. A guess at this instant: Kokoro can still fail and fall back. */
export const readMacVoice = async (): Promise<Outcome<MacVoiceStatus>> => {
	const config = await run(MacVoiceConfig.useSync((config) => config));
	if (!config.ok) return config;
	const { ttsUrl, ttsVoice, voice } = config.value;
	return (await kokoroAnswers(ttsUrl))
		? { ok: true, value: { engine: 'kokoro', voice: ttsVoice, fallbackVoice: voice } }
		: { ok: true, value: { engine: 'say', voice, fallbackVoice: voice } };
};

/**
 * One attempt, on one output: a serial means that Echo, no serial means this Mac. Never falls back
 * from one to the other, which could speak the same sentence twice. The Mac answers only after the
 * audio ended; the Echo answers when Amazon accepted the request.
 */
export const speak = (input: {
	readonly text: string;
	readonly deviceSerial?: string;
}): Promise<Outcome<Omit<SpeechReceipt, 'text' | 'at'>>> =>
	run(
		Effect.gen(function* () {
			if (input.deviceSerial !== undefined) {
				const alexa = yield* Alexa;
				const accepted = yield* alexa.speak(input);
				return { route: 'echo' as const, ...pick(accepted) };
			}
			const { speechEnabled } = yield* AlexaConfig;
			if (!speechEnabled) return yield* Effect.fail(speechDisabled());
			const mac = yield* MacVoice;
			const played = yield* mac.speak(input.text);
			return { route: 'mac' as const, ...pick(played) };
		})
	);

const pick = (result: { device: string; chunks: number; playbackConfirmed: boolean }) => ({
	device: result.device,
	chunks: result.chunks,
	playbackConfirmed: result.playbackConfirmed
});
