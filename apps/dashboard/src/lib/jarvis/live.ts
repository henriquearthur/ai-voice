import { sinaisLive } from '#lib/telemetria/web/coleta.js';

/**
 * Follows a server-sent events route the way every live page should, so a page left open costs almost nothing:
 *   - at most one update per `minIntervalMs` (default 1 s): frames in between are coalesced, the last one wins;
 *   - a frame identical to the previous one is dropped, so nothing re-renders when nothing changed;
 *   - while the document is hidden the stream is closed and the clock stops; both resume on visibility.
 * Reconnections, coalesced or repeated frames and the arrival-to-paint delay go to the frontend telemetry.
 * Returns the cleanup function, ready for `onMount`.
 */
export type LiveStatus = 'conectando' | 'ao-vivo' | 'reconectando';

export function followLive<T>(
	url: string,
	handlers: {
		onData: (value: T) => void;
		onStatus?: (status: LiveStatus) => void;
		/** Called at most every `tickMs` while visible, and once on becoming visible. */
		onTick?: (now: number) => void;
	},
	{ minIntervalMs = 1000, tickMs = 1000 }: { minIntervalMs?: number; tickMs?: number } = {}
): () => void {
	let source: EventSource | null = null;
	let tick: ReturnType<typeof setInterval> | undefined;
	let flush: ReturnType<typeof setTimeout> | undefined;
	let pending: string | null = null;
	/** `performance.now()` when the pending frame arrived. */
	let pendingAt = 0;
	let last = '';
	let lastAt = 0;

	const deliver = () => {
		flush = undefined;
		if (pending === null) return;
		const raw = pending;
		pending = null;
		lastAt = Date.now();
		if (raw === last) {
			sinaisLive.descarte(url, 'repetido');
			return;
		}
		last = raw;
		try {
			handlers.onData(JSON.parse(raw) as T);
			sinaisLive.entregue(url, pendingAt);
		} catch {
			// A broken frame: the next one replaces it.
		}
	};

	const open = () => {
		if (source) return;
		handlers.onStatus?.('conectando');
		source = new EventSource(url);
		source.onopen = () => handlers.onStatus?.('ao-vivo');
		source.onmessage = (event) => {
			handlers.onStatus?.('ao-vivo');
			if (pending !== null) sinaisLive.descarte(url, 'coalescido');
			pending = event.data;
			pendingAt = performance.now();
			if (flush) return;
			flush = setTimeout(deliver, Math.max(0, minIntervalMs - (Date.now() - lastAt)));
		};
		source.onerror = () => {
			sinaisLive.reconexao(url);
			handlers.onStatus?.('reconectando');
		};
		if (handlers.onTick) {
			handlers.onTick(Date.now());
			tick = setInterval(() => handlers.onTick?.(Date.now()), tickMs);
		}
	};

	const close = () => {
		source?.close();
		source = null;
		if (tick) clearInterval(tick);
		tick = undefined;
		if (flush) clearTimeout(flush);
		flush = undefined;
		pending = null;
	};

	const onVisibility = () => (document.hidden ? close() : open());
	document.addEventListener('visibilitychange', onVisibility);
	if (!document.hidden) open();

	return () => {
		document.removeEventListener('visibilitychange', onVisibility);
		close();
	};
}
