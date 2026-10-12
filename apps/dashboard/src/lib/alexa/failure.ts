/**
 * What the browser may learn about a failed speech call: a category and a message that is safe to show.
 * `voice` is the Mac (Kokoro or `say`); the other kinds come from the Echo side or the config.
 */
export type AlexaFailure = {
	readonly kind: 'session' | 'device' | 'speech' | 'voice' | 'config' | 'unexpected';
	readonly message: string;
};

export type Outcome<A> =
	| { readonly ok: true; readonly value: A }
	| { readonly ok: false; readonly failure: AlexaFailure };

/** Where a sentence leaves from: this Mac (the default) or one Echo through Alexa. */
export type SpeechRoute = 'mac' | 'echo';

/** What the page files after a sentence left. Only the Mac confirms that the audio played. */
export type SpeechReceipt = {
	readonly route: SpeechRoute;
	readonly device: string;
	readonly chunks: number;
	readonly playbackConfirmed: boolean;
	readonly text: string;
	readonly at: number;
};

/** The Mac voice as the server sees it right now: Kokoro answering, or the `say` fallback. */
export type MacVoiceStatus = {
	readonly engine: 'kokoro' | 'say';
	/** The voice that will actually speak: the Kokoro voice, or the `say` voice when Kokoro is down. */
	readonly voice: string;
	/** The `say` voice, kept for the fallback line. */
	readonly fallbackVoice: string;
};
