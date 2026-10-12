/**
 * The frontend's own telemetry: what one page sends to `POST /telemetria/cliente` every 15 s.
 *
 * Only low-cardinality labels travel: a SvelteKit route id (never the URL), an error's constructor
 * name (never its message), the live stream's path. The aggregator below is plain TypeScript with no
 * DOM, so the browser bundle stays small and the batching can be tested on its own.
 */

export type Origem = 'browser' | 'desktop';
export type Vital = 'LCP' | 'INP' | 'CLS' | 'TTFB';
export type MotivoDescarte = 'coalescido' | 'repetido';
export type EstadoVisivel = 'visivel' | 'oculto';

export const VITAIS: ReadonlyArray<Vital> = ['LCP', 'INP', 'CLS', 'TTFB'];
export const MOTIVOS: ReadonlyArray<MotivoDescarte> = ['coalescido', 'repetido'];

export type Lote = {
	readonly v: 1;
	readonly origem: Origem;
	/** LCP, INP and TTFB in milliseconds; CLS as the unitless layout-shift score. */
	readonly vitais: ReadonlyArray<{ readonly m: Vital; readonly rota: string; readonly v: number }>;
	readonly navegacoes: ReadonlyArray<{ readonly rota: string; readonly ms: number }>;
	readonly erros: ReadonlyArray<{ readonly tipo: string; readonly rota: string; readonly n: number }>;
	/** `fluxo` is the live stream's path, such as `/telemetria/ao-vivo`. */
	readonly reconexoes: ReadonlyArray<{ readonly fluxo: string; readonly n: number }>;
	/** From a frame reaching the page to the frame painted with it. */
	readonly atrasos: ReadonlyArray<{ readonly fluxo: string; readonly ms: number }>;
	readonly descartes: ReadonlyArray<{ readonly fluxo: string; readonly motivo: MotivoDescarte; readonly n: number }>;
	/** `usedJSHeapSize`, only where the engine exposes it (Chromium). */
	readonly heap: number | null;
	readonly tempo: { readonly visivelMs: number; readonly ocultoMs: number };
};

/** Hard caps, the same on both sides: the server drops anything beyond them. */
export const LIMITES = { bytes: 32 * 1024, itens: 120 } as const;

/** Anything that is not a plain identifier becomes `outro`: a constructor name, never a message. */
export function tipoDeErro(valor: unknown, prefixo = ''): string {
	let nome = 'outro';
	if (valor instanceof Error || (typeof valor === 'object' && valor !== null && 'name' in valor)) {
		const n = (valor as { name?: unknown }).name;
		nome = typeof n === 'string' && /^[A-Za-z_$][\w$]{0,39}$/.test(n) ? n : 'Error';
	} else if (valor === undefined || valor === null) nome = String(valor);
	else nome = typeof valor;
	return prefixo + nome;
}

const chave = (...partes: string[]) => partes.join('\u0000');

/** Collects one page's signals between two sends. `fechar` hands the batch over and starts a new one. */
export class Agregador {
	#vitais: Array<{ m: Vital; rota: string; v: number }> = [];
	#navegacoes: Array<{ rota: string; ms: number }> = [];
	#atrasos: Array<{ fluxo: string; ms: number }> = [];
	#erros = new Map<string, { tipo: string; rota: string; n: number }>();
	#reconexoes = new Map<string, { fluxo: string; n: number }>();
	#descartes = new Map<string, { fluxo: string; motivo: MotivoDescarte; n: number }>();
	#tempo = { visivelMs: 0, ocultoMs: 0 };

	constructor(readonly origem: Origem) {}

	vital(m: Vital, rota: string, v: number) {
		if (Number.isFinite(v) && v >= 0 && this.#vitais.length < LIMITES.itens) this.#vitais.push({ m, rota, v });
	}

	navegacao(rota: string, ms: number) {
		if (Number.isFinite(ms) && ms >= 0 && this.#navegacoes.length < LIMITES.itens) this.#navegacoes.push({ rota, ms: Math.round(ms) });
	}

	atraso(fluxo: string, ms: number) {
		if (Number.isFinite(ms) && ms >= 0 && this.#atrasos.length < LIMITES.itens) this.#atrasos.push({ fluxo, ms: Math.round(ms) });
	}

	erro(tipo: string, rota: string) {
		const k = chave(tipo, rota);
		const atual = this.#erros.get(k);
		if (atual) atual.n++;
		else if (this.#erros.size < LIMITES.itens) this.#erros.set(k, { tipo, rota, n: 1 });
	}

	reconexao(fluxo: string) {
		const atual = this.#reconexoes.get(fluxo);
		if (atual) atual.n++;
		else if (this.#reconexoes.size < LIMITES.itens) this.#reconexoes.set(fluxo, { fluxo, n: 1 });
	}

	descarte(fluxo: string, motivo: MotivoDescarte) {
		const k = chave(fluxo, motivo);
		const atual = this.#descartes.get(k);
		if (atual) atual.n++;
		else if (this.#descartes.size < LIMITES.itens) this.#descartes.set(k, { fluxo, motivo, n: 1 });
	}

	tempo(estado: EstadoVisivel, ms: number) {
		if (!Number.isFinite(ms) || ms <= 0) return;
		if (estado === 'visivel') this.#tempo.visivelMs += ms;
		else this.#tempo.ocultoMs += ms;
	}

	/** True when only visible/hidden time is waiting: not worth a request while the page is hidden. */
	get soTempo(): boolean {
		return !this.#vitais.length && !this.#navegacoes.length && !this.#atrasos.length && !this.#erros.size && !this.#reconexoes.size && !this.#descartes.size;
	}

	get vazio(): boolean {
		return this.soTempo && this.#tempo.visivelMs === 0 && this.#tempo.ocultoMs === 0;
	}

	/** The batch so far, or null when there is nothing to send; either way the aggregator starts over. */
	fechar(heap: number | null = null): Lote | null {
		if (this.vazio) return null;
		const lote: Lote = {
			v: 1,
			origem: this.origem,
			vitais: this.#vitais,
			navegacoes: this.#navegacoes,
			erros: [...this.#erros.values()],
			reconexoes: [...this.#reconexoes.values()],
			atrasos: this.#atrasos,
			descartes: [...this.#descartes.values()],
			heap: heap !== null && Number.isFinite(heap) && heap > 0 ? Math.round(heap) : null,
			tempo: { visivelMs: Math.round(this.#tempo.visivelMs), ocultoMs: Math.round(this.#tempo.ocultoMs) }
		};
		this.#vitais = [];
		this.#navegacoes = [];
		this.#atrasos = [];
		this.#erros = new Map();
		this.#reconexoes = new Map();
		this.#descartes = new Map();
		this.#tempo = { visivelMs: 0, ocultoMs: 0 };
		return lote;
	}
}
