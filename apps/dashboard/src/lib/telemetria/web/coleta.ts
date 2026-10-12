import { Agregador, type MotivoDescarte, type Origem, tipoDeErro } from './lote.js';

/**
 * The browser side of the frontend telemetry, with no SDK: a few PerformanceObservers, the error
 * events and the live stream's own signals, batched by `Agregador` and posted every 15 s to
 * `/telemetria/cliente` (with `sendBeacon` when the page goes away). Started once by the root layout;
 * before that every call is a no-op, so `live.ts` can report without caring whether it runs.
 */

const ENDPOINT = '/telemetria/cliente';
const ENVIO_MS = 15_000;

declare global {
	interface Window {
		/** Set by the Jarvis.app shell, as an alternative to its user agent. */
		__JARVIS_DESKTOP__?: boolean;
	}
}

/** The Jarvis.app shell is a WKWebView whose user agent ends with `JarvisDesktop/<versão>`. */
export function origemDe(userAgent: string, flag?: boolean): Origem {
	return flag === true || /\bJarvisDesktop\//.test(userAgent) ? 'desktop' : 'browser';
}

let agregador: Agregador | null = null;
let rotaAtual = 'sem-rota';

/** Path only, so `/telemetria/ao-vivo?x=1` and the absolute form read the same. */
const fluxoDe = (url: string) => {
	try {
		return new URL(url, location.href).pathname;
	} catch {
		return 'outro';
	}
};

/** Signals from `followLive` (see `live.ts`). */
export const sinaisLive = {
	reconexao(url: string) {
		agregador?.reconexao(fluxoDe(url));
	},
	descarte(url: string, motivo: MotivoDescarte) {
		agregador?.descarte(fluxoDe(url), motivo);
	},
	/** `chegadaEm` is `performance.now()` when the delivered frame arrived; measured to the next paint. */
	entregue(url: string, chegadaEm: number) {
		if (!agregador) return;
		const fluxo = fluxoDe(url);
		requestAnimationFrame(() => agregador?.atraso(fluxo, performance.now() - chegadaEm));
	}
};

/** SvelteKit client navigations: call `inicio` in beforeNavigate and `fim` in afterNavigate. */
let navegacaoDesde: number | null = null;
export const sinaisNavegacao = {
	inicio() {
		navegacaoDesde = performance.now();
	},
	fim(rota: string | null) {
		const desde = navegacaoDesde;
		navegacaoDesde = null;
		fecharVisao();
		rotaAtual = rota ?? 'sem-rota';
		if (desde === null || !agregador) return;
		const destino = rotaAtual;
		// One frame later the new page has been painted.
		requestAnimationFrame(() => setTimeout(() => agregador?.navegacao(destino, performance.now() - desde), 0));
	}
};

/* ---------------------------------------------------------------------------------------------- */
/* Web Vitals, the small way                                                                       */
/* ---------------------------------------------------------------------------------------------- */

// Per route view: the worst interaction (INP) and the largest session window of layout shifts (CLS).
let interacoes = new Map<number, number>();
let cls = 0;
let janela = { valor: 0, inicio: 0, ultimo: 0 };
/** Finalizes the first load's LCP; a no-op once done. */
let fecharLcpAtual = () => {};

/** Reports the current view's INP and CLS and starts a new view. */
function fecharVisao() {
	if (!agregador) return;
	if (interacoes.size) {
		const duracoes = [...interacoes.values()].sort((a, b) => b - a);
		// web-vitals' rule: the worst interaction, ignoring one per 50 interactions.
		agregador.vital('INP', rotaAtual, duracoes[Math.min(duracoes.length - 1, Math.floor(duracoes.length / 50))]);
	}
	if (cls > 0) agregador.vital('CLS', rotaAtual, Math.round(cls * 10_000) / 10_000);
	interacoes = new Map();
	cls = 0;
	janela = { valor: 0, inicio: 0, ultimo: 0 };
}

const suporta = (tipo: string) => typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes(tipo);

function observar(tipo: string, cb: (entries: PerformanceEntryList) => void, extra: Record<string, unknown> = {}): PerformanceObserver | null {
	if (!suporta(tipo)) return null;
	try {
		const po = new PerformanceObserver((list) => cb(list.getEntries()));
		po.observe({ type: tipo, buffered: true, ...extra } as PerformanceObserverInit);
		return po;
	} catch {
		return null;
	}
}

type EventTiming = PerformanceEntry & { interactionId?: number };
type LayoutShift = PerformanceEntry & { value: number; hadRecentInput: boolean };

function webVitals(rotaInicial: string): () => void {
	const observers: Array<PerformanceObserver | null> = [];

	const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
	if (nav && nav.responseStart > 0) agregador?.vital('TTFB', rotaInicial, Math.round(nav.responseStart));

	// LCP: only the first load has one; it is final at the first input or when the page is hidden.
	let lcp: number | null = null;
	const lcpObs = observar('largest-contentful-paint', (entries) => {
		const ultimo = entries.at(-1);
		if (ultimo) lcp = ultimo.startTime;
	});
	let lcpAberto = lcpObs !== null;
	const fecharLcp = () => {
		if (!lcpAberto) return;
		lcpAberto = false;
		lcpObs?.disconnect();
		if (lcp !== null) agregador?.vital('LCP', rotaInicial, Math.round(lcp));
		lcp = null;
		for (const t of ['keydown', 'pointerdown'] as const) removeEventListener(t, fecharLcp, true);
	};
	if (lcpObs) for (const t of ['keydown', 'pointerdown'] as const) addEventListener(t, fecharLcp, { capture: true, once: true });
	fecharLcpAtual = fecharLcp;
	observers.push(lcpObs);

	observers.push(
		observar(
			'event',
			(entries) => {
				for (const e of entries as EventTiming[]) {
					if (!e.interactionId) continue;
					interacoes.set(e.interactionId, Math.max(interacoes.get(e.interactionId) ?? 0, e.duration));
				}
			},
			{ durationThreshold: 40 }
		)
	);

	observers.push(
		observar('layout-shift', (entries) => {
			for (const e of entries as LayoutShift[]) {
				if (e.hadRecentInput) continue;
				const mesma = janela.valor > 0 && e.startTime - janela.ultimo < 1000 && e.startTime - janela.inicio < 5000;
				janela = mesma ? { valor: janela.valor + e.value, inicio: janela.inicio, ultimo: e.startTime } : { valor: e.value, inicio: e.startTime, ultimo: e.startTime };
				cls = Math.max(cls, janela.valor);
			}
		})
	);

	return () => {
		fecharLcp();
		for (const o of observers) o?.disconnect();
	};
}

/* ---------------------------------------------------------------------------------------------- */
/* Sending                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

const heap = (): number | null => {
	const m = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
	return typeof m?.usedJSHeapSize === 'number' ? m.usedJSHeapSize : null;
};

let estadoDesde = 0;
let visivel = true;

function contarTempo() {
	const agora = performance.now();
	agregador?.tempo(visivel ? 'visivel' : 'oculto', agora - estadoDesde);
	estadoDesde = agora;
}

function enviar(saindo: boolean) {
	if (!agregador) return;
	contarTempo();
	// While hidden, the visible/hidden clock alone waits for the next real send.
	if (!saindo && document.hidden && agregador.soTempo) return;
	if (saindo) {
		fecharLcpAtual();
		fecharVisao();
	}
	const lote = agregador.fechar(heap());
	if (!lote) return;
	const body = JSON.stringify(lote);
	try {
		if (saindo && navigator.sendBeacon?.(ENDPOINT, new Blob([body], { type: 'application/json' }))) return;
		void fetch(ENDPOINT, { method: 'POST', body, keepalive: true, headers: { 'content-type': 'application/json' } }).catch(() => {});
	} catch {
		// Telemetry never breaks the page.
	}
}

/** Starts collecting for this document. Returns the cleanup, ready for `onMount`. */
export function iniciarColeta(rotaInicial: string | null): () => void {
	if (agregador) return () => {};
	agregador = new Agregador(origemDe(navigator.userAgent, window.__JARVIS_DESKTOP__));
	rotaAtual = rotaInicial ?? 'sem-rota';
	visivel = !document.hidden;
	estadoDesde = performance.now();

	const pararVitals = webVitals(rotaAtual);

	const onErro = (e: ErrorEvent) => agregador?.erro(tipoDeErro(e.error ?? { name: 'Error' }), rotaAtual);
	const onRejeicao = (e: PromiseRejectionEvent) => agregador?.erro(tipoDeErro(e.reason, 'rejeicao/'), rotaAtual);
	const onVisibilidade = () => {
		contarTempo();
		visivel = !document.hidden;
		if (document.hidden) enviar(true);
	};
	const onSaida = () => enviar(true);

	addEventListener('error', onErro);
	addEventListener('unhandledrejection', onRejeicao);
	document.addEventListener('visibilitychange', onVisibilidade);
	addEventListener('pagehide', onSaida);
	const timer = setInterval(() => enviar(false), ENVIO_MS);

	return () => {
		clearInterval(timer);
		removeEventListener('error', onErro);
		removeEventListener('unhandledrejection', onRejeicao);
		document.removeEventListener('visibilitychange', onVisibilidade);
		removeEventListener('pagehide', onSaida);
		pararVitals();
		enviar(true);
		agregador = null;
	};
}
