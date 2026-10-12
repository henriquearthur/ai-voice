/**
 * The voice conversation, rebuilt from what the Mac actually writes down:
 *
 * - the escuta's event log (`escuta.events.jsonl`, one JSON object per line, `ts` in UTC), which says
 *   what was heard, which requests went out, whether they were delivered, and when the speech lock was held;
 * - the local voice server's log (`server.err.log`), one `synth` line per spoken answer, with its size
 *   but never its text.
 *
 * Pure: the server reads the files and hands the lines here; the page recomputes the phase every second.
 */

export type EscutaEvent = { readonly type: string; readonly at: number; readonly [key: string]: unknown };

/** One answer the local voice server synthesised. The text is not logged, only its size. */
export type Synth = {
	readonly at: number;
	readonly voice: string;
	readonly chars: number;
	/** Seconds of audio (WAV size at 24 kHz, 16-bit mono). */
	readonly speech: number;
	/** Seconds the synthesis took. */
	readonly took: number;
};

export type ProcessState = {
	/** running: the LaunchAgent has a process. stopped: loaded but not running (quit). unloaded: not in launchd. */
	readonly state: 'running' | 'stopped' | 'unloaded' | 'unknown';
	readonly pid: number | null;
};

export type Reply = { readonly key: string; readonly at: number; readonly chars: number; readonly speech: number; readonly took: number };

export type RequestTurn = {
	readonly kind: 'pedido';
	readonly key: string;
	readonly at: number;
	/** What went to the orchestrator (without the wake word). */
	readonly text: string;
	/** The whole sentence as heard, wake word included, when the escuta logged it. */
	readonly heard: string | null;
	/** Seconds the sentence lasted. */
	readonly utterance: number | null;
	readonly delivery: 'enviando' | 'entregue' | 'falhou';
	/** End of speech to delivered, in ms (the escuta's fala→texto→entrega). */
	readonly latencyMs: number | null;
	/** Time the delivery itself took, in ms. */
	readonly sendMs: number | null;
	readonly who: string | null;
	readonly detail: string | null;
	readonly replies: ReadonlyArray<Reply>;
};

/** Jarvis spoke with no voice request right before (a notice, or an answer to something typed). */
export type NoticeTurn = { readonly kind: 'aviso'; readonly key: string; readonly at: number; readonly replies: ReadonlyArray<Reply> };

export type Turn = RequestTurn | NoticeTurn;

export type Ignored = {
	readonly key: string;
	readonly at: number;
	readonly text: string;
	readonly seconds: number | null;
	/** Only the wake word was said: the escuta opened its window and waited for the request. */
	readonly armed: boolean;
};

export type Live = {
	readonly paused: boolean;
	readonly speakingSince: number | null;
	readonly pendingSince: number | null;
	readonly lastRoutedAt: number | null;
	readonly armedUntil: number | null;
	readonly restartingSince: number | null;
	readonly error: { readonly at: number; readonly message: string } | null;
};

export type Health = {
	readonly readyAt: number | null;
	readonly mic: string | null;
	readonly silence: number | null;
	readonly openSilence: number | null;
	readonly airpods: { readonly device: string; readonly rate: number } | null;
	readonly recognizer: { readonly at: number; readonly generation: number; readonly reason: string } | null;
	readonly recognizerError: { readonly at: number; readonly message: string } | null;
	readonly lastRestart: { readonly at: number; readonly reason: string } | null;
	readonly restartsToday: number;
};

export type Snapshot = {
	readonly generatedAt: number;
	/** False when the escuta has never written its event log on this Mac. */
	readonly installed: boolean;
	readonly process: ProcessState;
	/** The local voice server (Kokoro) answered /health. */
	readonly voice: 'ok' | 'off' | 'unknown';
	readonly live: Live;
	readonly health: Health;
	readonly turns: ReadonlyArray<Turn>;
	readonly ignored: ReadonlyArray<Ignored>;
	/** Heard fragments with no words at all (a cough, a dot): counted, not listed. */
	readonly noise: number;
};

const TURN_LIMIT = 40;
const IGNORED_LIMIT = 40;
/** A spoken answer belongs to the last request if it starts within this long after it. */
const REPLY_WINDOW = 10 * 60_000;
/** Spoken notices this close together are one turn. */
const NOTICE_GAP = 90_000;
/** Kokoro's output: 24 kHz, 16-bit mono WAV with a 44-byte header. */
const BYTES_PER_SECOND = 24_000 * 2;

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export function parseEvents(lines: ReadonlyArray<string>): EscutaEvent[] {
	const events: EscutaEvent[] = [];
	for (const line of lines) {
		if (!line.startsWith('{')) continue;
		try {
			const raw = JSON.parse(line) as Record<string, unknown>;
			const type = str(raw.type);
			const at = Date.parse(str(raw.ts) ?? '');
			if (type && Number.isFinite(at)) events.push({ ...raw, type, at });
		} catch {
			// A line cut by the tail read or a half-written line: skip it.
		}
	}
	return events;
}

// 2026-10-12 00:06:54,072 INFO synth voice=pf_dora chars=189 bytes=571244 0.637s  (local time)
const SYNTH = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d),(\d{3}) INFO synth voice=(\S+) chars=(\d+) bytes=(\d+) ([\d.]+)s/;

export function parseSynth(lines: ReadonlyArray<string>): Synth[] {
	const out: Synth[] = [];
	for (const line of lines) {
		const m = SYNTH.exec(line);
		if (!m) continue;
		const [y, mo, d, h, mi, s, ms] = m.slice(1, 8).map(Number);
		out.push({
			at: new Date(y, mo - 1, d, h, mi, s, ms).getTime(),
			voice: m[8],
			chars: Number(m[9]),
			speech: Math.max(0, (Number(m[10]) - 44) / BYTES_PER_SECOND),
			took: Number(m[11])
		});
	}
	return out;
}

const hasWords = (text: string) => /[\p{L}\p{N}]/u.test(text);

export function buildSnapshot(input: {
	events: ReadonlyArray<EscutaEvent>;
	synths: ReadonlyArray<Synth>;
	process: ProcessState;
	voice: Snapshot['voice'];
	installed: boolean;
	now: number;
}): Snapshot {
	const { events, synths, now } = input;

	type Draft = {
		-readonly [K in keyof RequestTurn]: RequestTurn[K];
	} & { replies: Reply[] };
	const requests: Draft[] = [];
	const byKey = new Map<string, Draft>();
	const heard: { ev: EscutaEvent; used: boolean }[] = [];

	let run = 0;
	let paused = false;
	let speakingSince: number | null = null;
	let pending: { key: string; at: number } | null = null;
	let lastRoutedAt: number | null = null;
	let armedUntil: number | null = null;
	let restartingSince: number | null = null;
	let error: Live['error'] = null;

	let readyAt: number | null = null;
	let mic: string | null = null;
	let silence: number | null = null;
	let openSilence: number | null = null;
	let airpods: Health['airpods'] = null;
	let recognizer: Health['recognizer'] = null;
	let recognizerError: Health['recognizerError'] = null;
	let lastRestart: Health['lastRestart'] = null;
	let restartsToday = 0;
	const midnight = new Date(now);
	midnight.setHours(0, 0, 0, 0);

	for (const ev of events) {
		switch (ev.type) {
			case 'restart':
			case 'stopped': {
				run += 1;
				paused = false;
				speakingSince = null;
				pending = null;
				armedUntil = null;
				if (ev.type === 'restart') {
					restartingSince = ev.at;
					lastRestart = { at: ev.at, reason: str(ev.reason) ?? '' };
					if (ev.at >= midnight.getTime()) restartsToday += 1;
				}
				break;
			}
			case 'ready':
				readyAt = ev.at;
				restartingSince = null;
				error = null;
				paused = false;
				mic = str(ev.mic) ?? mic;
				silence = num(ev.silence) ?? silence;
				openSilence = num(ev.open_silence) ?? openSilence;
				break;
			case 'paused':
				paused = true;
				armedUntil = null;
				break;
			case 'resumed':
				paused = false;
				break;
			case 'jarvis_speaking':
				speakingSince ??= ev.at;
				break;
			case 'jarvis_quiet':
				speakingSince = null;
				break;
			case 'error':
				error = { at: ev.at, message: str(ev.message) ?? 'Erro sem mensagem.' };
				break;
			case 'airpods': {
				const device = str(ev.device);
				const rate = num(ev.rate);
				if (device && rate !== null) airpods = { device, rate };
				break;
			}
			case 'recognizer': {
				const generation = num(ev.generation);
				if (generation === 1) {
					// A first recognizer is a new process. Without a restart event before it, the old one was killed
					// (launchctl kickstart, a crash): its ids start over and its pause and speech state are gone.
					if (restartingSince === null && readyAt !== null && ev.at > readyAt) run += 1;
					paused = false;
					pending = null;
					// The new process reports the speech lock just before this, only if it is held.
					if (speakingSince !== null && ev.at - speakingSince > 3000) speakingSince = null;
				}
				if (generation !== null) recognizer = { at: ev.at, generation, reason: str(ev.reason) ?? '' };
				break;
			}
			case 'recognizer_error':
				recognizerError = { at: ev.at, message: str(ev.message) ?? '' };
				break;
			case 'armed': {
				const seconds = num(ev.seconds) ?? 60;
				armedUntil = ev.at + seconds * 1000;
				break;
			}
			case 'heard': {
				const text = str(ev.text);
				if (text !== null) heard.push({ ev, used: false });
				break;
			}
			case 'command': {
				const id = num(ev.id);
				const text = str(ev.text) ?? '';
				if (id === null) break;
				const key = `${run}:${id}:${ev.at}`;
				// The sentence that produced it is the last heard one, logged in the same instant.
				const source = heard.at(-1);
				const matches = source && !source.used && ev.at - source.ev.at <= 3000;
				if (matches) source.used = true;
				const draft: Draft = {
					kind: 'pedido',
					key,
					at: ev.at,
					text,
					heard: matches ? str(source.ev.text) : null,
					utterance: matches ? num(source.ev.seconds) : null,
					delivery: 'enviando',
					latencyMs: null,
					sendMs: null,
					who: null,
					detail: null,
					replies: []
				};
				requests.push(draft);
				byKey.set(`${run}:${id}`, draft);
				pending = { key, at: ev.at };
				break;
			}
			case 'routed': {
				const id = num(ev.id);
				const draft = id === null ? undefined : byKey.get(`${run}:${id}`);
				if (!draft) break;
				const ok = ev.ok === true;
				draft.delivery = ok ? 'entregue' : 'falhou';
				draft.latencyMs = num(ev.latency_ms);
				draft.sendMs = num(ev.ms);
				draft.who = str(ev.who);
				draft.detail = str(ev.detail) || null;
				if (pending?.key === draft.key) pending = null;
				lastRoutedAt = ev.at;
				// After a request, speech started within the conversation window also counts.
				armedUntil = Math.max(armedUntil ?? 0, ev.at + 8000);
				break;
			}
		}
	}

	// Spoken answers: each one goes to the last request before it, if that request is recent enough.
	const notices: { key: string; at: number; replies: Reply[] }[] = [];
	let r = -1;
	for (const synth of synths) {
		while (r + 1 < requests.length && requests[r + 1].at <= synth.at) r += 1;
		const reply: Reply = { key: `s:${synth.at}:${synth.chars}`, at: synth.at, chars: synth.chars, speech: synth.speech, took: synth.took };
		const owner = r >= 0 ? requests[r] : undefined;
		if (owner && synth.at - owner.at <= REPLY_WINDOW) {
			owner.replies.push(reply);
			continue;
		}
		const last = notices.at(-1);
		const lastAt = last?.replies.at(-1)?.at;
		if (last && lastAt !== undefined && synth.at - lastAt <= NOTICE_GAP && (owner === undefined || owner.at < last.at)) {
			last.replies.push(reply);
		} else {
			notices.push({ key: `a:${synth.at}`, at: synth.at, replies: [reply] });
		}
	}

	const turns: Turn[] = [
		...requests,
		...notices.map((n): NoticeTurn => ({ kind: 'aviso', key: n.key, at: n.at, replies: n.replies }))
	]
		.sort((a, b) => b.at - a.at)
		.slice(0, TURN_LIMIT);

	let noise = 0;
	const ignored: Ignored[] = [];
	for (let i = heard.length - 1; i >= 0; i -= 1) {
		const { ev, used } = heard[i];
		if (used) continue;
		const text = str(ev.text) ?? '';
		if (!hasWords(text)) {
			noise += 1;
			continue;
		}
		if (ignored.length < IGNORED_LIMIT) {
			ignored.push({ key: `h:${ev.at}:${i}`, at: ev.at, text, seconds: num(ev.seconds), armed: ev.wake === true });
		}
	}

	return {
		generatedAt: now,
		installed: input.installed,
		process: input.process,
		voice: input.voice,
		live: { paused, speakingSince, pendingSince: pending?.at ?? null, lastRoutedAt, armedUntil, restartingSince, error },
		health: { readyAt, mic, silence, openSilence, airpods, recognizer, recognizerError, lastRestart, restartsToday },
		turns,
		ignored,
		noise
	};
}

export type PhaseId =
	| 'ouvindo'
	| 'captando'
	| 'enviando'
	| 'entregue'
	| 'falando'
	| 'pausada'
	| 'reiniciando'
	| 'erro'
	| 'desligada';

/** How the wave moves: breathing low, a voice, a sweep going out, Jarvis's voice, or a flat line. */
export type WaveMode = 'idle' | 'voice' | 'send' | 'speak' | 'flat';
export type Tone = 'positive' | 'brand' | 'neutral' | 'caution' | 'alert';

export type Phase = { readonly id: PhaseId; readonly label: string; readonly hint: string; readonly tone: Tone; readonly wave: WaveMode };

/** Recomputed every second on the page: windows close on their own, without a new event. */
export function phaseAt(s: Snapshot, now: number): Phase {
	const { live, process } = s;
	if (process.state === 'unloaded' || process.state === 'stopped') {
		return {
			id: 'desligada',
			label: 'Desligada',
			hint:
				process.state === 'stopped'
					? 'A escuta foi encerrada e não está ouvindo. Ligue para voltar a ouvir.'
					: 'A escuta não está carregada no launchd, então nada é ouvido. Ligue para voltar a ouvir.',
			tone: 'neutral',
			wave: 'flat'
		};
	}
	if (live.restartingSince !== null && now - live.restartingSince < 30_000) {
		return { id: 'reiniciando', label: 'Reiniciando', hint: 'Abrindo o microfone e o reconhecimento de novo.', tone: 'caution', wave: 'flat' };
	}
	if (live.error) {
		return { id: 'erro', label: 'Com erro', hint: live.error.message, tone: 'alert', wave: 'flat' };
	}
	if (live.paused) {
		return {
			id: 'pausada',
			label: 'Pausada',
			hint: 'Pausada no painel da barra de menus: o microfone está fechado.',
			tone: 'neutral',
			wave: 'flat'
		};
	}
	if (live.speakingSince !== null && now - live.speakingSince < 5 * 60_000) {
		return { id: 'falando', label: 'Jarvis falando', hint: 'Enquanto ele fala, a escuta não transcreve a voz dele.', tone: 'brand', wave: 'speak' };
	}
	if (live.pendingSince !== null && now - live.pendingSince < 20_000) {
		return { id: 'enviando', label: 'Enviando', hint: 'Pedido transcrito, entregando ao orquestrador.', tone: 'brand', wave: 'send' };
	}
	if (live.lastRoutedAt !== null && now - live.lastRoutedAt < 8000) {
		return {
			id: 'entregue',
			label: 'Pedido entregue',
			hint: 'Se continuar falando agora, vai junto, sem precisar dizer “Jarvis”.',
			tone: 'brand',
			wave: 'voice'
		};
	}
	if (live.armedUntil !== null && now < live.armedUntil) {
		return { id: 'captando', label: 'Captando', hint: 'Ouviu “Jarvis”. Pode falar o pedido.', tone: 'positive', wave: 'voice' };
	}
	return { id: 'ouvindo', label: 'Ouvindo', hint: 'Diga “Jarvis” e o pedido.', tone: 'positive', wave: 'idle' };
}

/** Median of the delivered requests' end-of-speech → delivered latency. */
export function medianLatency(turns: ReadonlyArray<Turn>): number | null {
	const values = turns
		.flatMap((t) => (t.kind === 'pedido' && t.latencyMs !== null ? [t.latencyMs] : []))
		.sort((a, b) => a - b);
	if (values.length === 0) return null;
	const mid = Math.floor(values.length / 2);
	return values.length % 2 ? values[mid] : Math.round((values[mid - 1] + values[mid]) / 2);
}

const WAKE = /^(\s*(?:jarvis|jarvys|jarbas|jarves|jarvi|djarvis|jervis|jarviz|camarada)\p{L}*[\s,.:;!?-]*)(.*)$/isu;

/**
 * Splits the heard sentence into what came before the request (the wake word, or other words glued
 * before it) and the request itself, for highlighting.
 */
export function splitHeard(heard: string, request: string): { lead: string; rest: string } | null {
	const at = request ? heard.lastIndexOf(request) : -1;
	if (at > 0) return { lead: heard.slice(0, at), rest: heard.slice(at) };
	const m = WAKE.exec(heard);
	return m ? { lead: m[1], rest: m[2] } : null;
}
