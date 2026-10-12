import * as Telemetry from '@jarvis/telemetry';
import { LATENCY_BOUNDARIES_MS } from '@jarvis/telemetry';
import { Effect, Layer, ManagedRuntime, Metric } from 'effect';
import { LIMITES, type Lote, MOTIVOS, type MotivoDescarte, type Origem, VITAIS, type Vital } from '../telemetria/web/lote.js';
import pkg from '../../../package.json' with { type: 'json' };

/**
 * The frontend's telemetry on the server: validates what `POST /telemetria/cliente` receives and turns it
 * into OTLP metrics under its own `service.name`, `jarvis-dashboard-web`.
 *
 * It reuses the shared exporter (`@jarvis/telemetry`) with a metric registry of its own, so these metrics
 * leave only as `jarvis-dashboard-web` and the server's own (`jarvis-dashboard`) are not exported twice.
 */

const registry: Metric.MetricRegistry = new Map();

const WebTelemetryLive = Telemetry.layer({ serviceName: 'jarvis-dashboard-web', serviceVersion: pkg.version }).pipe(
	Layer.provideMerge(Layer.succeed(Metric.MetricRegistry)(registry))
);

const runtime = ManagedRuntime.make(WebTelemetryLive);

process.once('sveltekit:shutdown', () => void runtime.dispose());
import.meta.hot?.dispose(() => runtime.dispose());

/* ---------------------------------------------------------------------------------------------- */
/* Metrics                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

const VITAL_BOUNDARIES_MS = [25, 50, 100, 150, 200, 300, 500, 800, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 8000, 12000, 20000];

export const metricas = {
	vital: Metric.histogram('jarvis_web_vital_ms', {
		description: 'Web Vitals do app (LCP, INP, TTFB), em milissegundos, por rota e origem.',
		boundaries: VITAL_BOUNDARIES_MS
	}),
	cls: Metric.histogram('jarvis_web_cls', {
		description: 'Cumulative Layout Shift do app (pontuação sem unidade), por rota e origem.',
		boundaries: [0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.4, 0.6, 1]
	}),
	navegacao: Metric.histogram('jarvis_web_navegacao_ms', {
		description: 'Navegação entre rotas do SvelteKit, do clique até a nova página pintada.',
		boundaries: LATENCY_BOUNDARIES_MS
	}),
	erros: Metric.counter('jarvis_web_erros_total', { description: 'Erros JS e rejeições não tratadas no app, por tipo e rota.', incremental: true }),
	reconexoes: Metric.counter('jarvis_web_sse_reconexoes_total', { description: 'Reconexões dos fluxos ao vivo (SSE) do app.', incremental: true }),
	atraso: Metric.histogram('jarvis_web_sse_atraso_ms', {
		description: 'Do quadro ao vivo chegar à página até ele estar pintado.',
		boundaries: [1, 2, 5, 10, 16, 25, 50, 100, 250, 500, 1000, 2000, 5000]
	}),
	descartes: Metric.counter('jarvis_web_sse_descartados_total', {
		description: 'Quadros ao vivo descartados pelo live.ts: coalescidos (limite de 1 Hz) ou repetidos.',
		incremental: true
	}),
	heap: Metric.gauge('jarvis_web_heap_bytes', { description: 'JS heap usado pela página, onde o motor expõe (Chromium).' }),
	tempo: Metric.counter('jarvis_web_tempo_segundos_total', { description: 'Tempo de página aberta, visível ou oculta.', incremental: true }),
	lotes: Metric.counter('jarvis_web_lotes_total', { description: 'Lotes de telemetria recebidos do app.', incremental: true })
} as const;

/* ---------------------------------------------------------------------------------------------- */
/* Validation                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

const ROTAS_MAX = 40;
const rotasVistas = new Set<string>();

/** A SvelteKit route id such as `/telemetria` or `/agenda/[id]`; at most 40 distinct, then `outra`. */
export function rotaSegura(v: unknown): string {
	if (v === 'sem-rota') return v;
	if (typeof v !== 'string' || !/^\/[\w\-/[\]().=]{0,79}$/.test(v)) return 'outra';
	if (!rotasVistas.has(v)) {
		if (rotasVistas.size >= ROTAS_MAX) return 'outra';
		rotasVistas.add(v);
	}
	return v;
}

const fluxoSeguro = (v: unknown) => (typeof v === 'string' && /^\/[\w\-/]{0,79}$/.test(v) ? v : 'outro');
const tipoSeguro = (v: unknown) => (typeof v === 'string' && /^(rejeicao\/)?[A-Za-z_$][\w$]{0,39}$/.test(v) ? v : 'outro');
const numero = (v: unknown, max: number): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : null);
const contagem = (v: unknown) => {
	const n = numero(v, 10_000);
	return n === null ? null : Math.round(n);
};
const lista = (v: unknown): unknown[] => (Array.isArray(v) ? v.slice(0, LIMITES.itens) : []);
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * The batch as the server trusts it, or null when it is not one. Unknown fields are ignored, lists are cut
 * at `LIMITES.itens`, numbers clamped, and every label passes a whitelist or a strict pattern.
 */
export function lerLote(raw: unknown): Lote | null {
	const o = obj(raw);
	if (o.v !== 1 || (o.origem !== 'browser' && o.origem !== 'desktop')) return null;
	const origem: Origem = o.origem;
	const vitais = lista(o.vitais).flatMap((x) => {
		const i = obj(x);
		const v = numero(i.v, i.m === 'CLS' ? 100 : 600_000);
		return VITAIS.includes(i.m as Vital) && v !== null ? [{ m: i.m as Vital, rota: rotaSegura(i.rota), v }] : [];
	});
	const navegacoes = lista(o.navegacoes).flatMap((x) => {
		const i = obj(x);
		const ms = numero(i.ms, 600_000);
		return ms === null ? [] : [{ rota: rotaSegura(i.rota), ms }];
	});
	const erros = lista(o.erros).flatMap((x) => {
		const i = obj(x);
		const n = contagem(i.n);
		return n ? [{ tipo: tipoSeguro(i.tipo), rota: rotaSegura(i.rota), n }] : [];
	});
	const reconexoes = lista(o.reconexoes).flatMap((x) => {
		const i = obj(x);
		const n = contagem(i.n);
		return n ? [{ fluxo: fluxoSeguro(i.fluxo), n }] : [];
	});
	const atrasos = lista(o.atrasos).flatMap((x) => {
		const i = obj(x);
		const ms = numero(i.ms, 600_000);
		return ms === null ? [] : [{ fluxo: fluxoSeguro(i.fluxo), ms }];
	});
	const descartes = lista(o.descartes).flatMap((x) => {
		const i = obj(x);
		const n = contagem(i.n);
		return n && MOTIVOS.includes(i.motivo as MotivoDescarte) ? [{ fluxo: fluxoSeguro(i.fluxo), motivo: i.motivo as MotivoDescarte, n }] : [];
	});
	const t = obj(o.tempo);
	// A batch covers 15 s; an hour is a generous cap for a page that slept through its timer.
	const HORA = 3_600_000;
	return {
		v: 1,
		origem,
		vitais,
		navegacoes,
		erros,
		reconexoes,
		atrasos,
		descartes,
		heap: numero(o.heap, 64 * 1024 ** 3) || null,
		tempo: { visivelMs: numero(t.visivelMs, HORA) ?? 0, ocultoMs: numero(t.ocultoMs, HORA) ?? 0 }
	};
}

/* ---------------------------------------------------------------------------------------------- */
/* Recording                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

type Atualizacao = { metrica: Metric.Metric<number, unknown>; labels: Record<string, string>; valor: number };

/** The updates one batch makes, in order. Pure, so the tests read them directly. */
export function atualizacoes(lote: Lote): Atualizacao[] {
	const { origem } = lote;
	const out: Atualizacao[] = [{ metrica: metricas.lotes, labels: { origem }, valor: 1 }];
	for (const { m, rota, v } of lote.vitais) {
		out.push(m === 'CLS' ? { metrica: metricas.cls, labels: { rota, origem }, valor: v } : { metrica: metricas.vital, labels: { metrica: m, rota, origem }, valor: v });
	}
	for (const { rota, ms } of lote.navegacoes) out.push({ metrica: metricas.navegacao, labels: { rota, origem }, valor: ms });
	for (const { tipo, rota, n } of lote.erros) out.push({ metrica: metricas.erros, labels: { tipo, rota, origem }, valor: n });
	for (const { fluxo, n } of lote.reconexoes) out.push({ metrica: metricas.reconexoes, labels: { fluxo, origem }, valor: n });
	for (const { fluxo, ms } of lote.atrasos) out.push({ metrica: metricas.atraso, labels: { fluxo, origem }, valor: ms });
	for (const { fluxo, motivo, n } of lote.descartes) out.push({ metrica: metricas.descartes, labels: { fluxo, motivo, origem }, valor: n });
	if (lote.heap !== null) out.push({ metrica: metricas.heap, labels: { origem }, valor: lote.heap });
	if (lote.tempo.visivelMs > 0) out.push({ metrica: metricas.tempo, labels: { estado: 'visivel', origem }, valor: lote.tempo.visivelMs / 1000 });
	if (lote.tempo.ocultoMs > 0) out.push({ metrica: metricas.tempo, labels: { estado: 'oculto', origem }, valor: lote.tempo.ocultoMs / 1000 });
	return out;
}

/**
 * Prometheus' `increase()` ignores a series' first sample, so an error counted the moment its series is
 * born would never show. A new series is therefore registered at zero right away and its first value
 * lands one export later (the exporter runs every 15 s).
 */
let atrasoSerieNovaMs = 20_000;
const seriesVistas = new Set<string>();

export function configurarAtrasoSerieNova(ms: number) {
	atrasoSerieNovaMs = ms;
}

const chaveSerie = (u: Atualizacao) => `${(u.metrica as { id: string }).id}|${JSON.stringify(u.labels)}`;

const aplicar = (us: ReadonlyArray<Atualizacao>) =>
	Effect.forEach(us, (u) => Metric.update(Metric.withAttributes(u.metrica, u.labels), u.valor), { discard: true });

/** Records one validated batch. Resolves once the immediate updates are in. */
export async function registrarLote(lote: Lote): Promise<void> {
	const agora: Atualizacao[] = [];
	const depois: Atualizacao[] = [];
	const novas: Atualizacao[] = [];
	for (const u of atualizacoes(lote)) {
		const k = chaveSerie(u);
		if (seriesVistas.has(k) || u.metrica === metricas.heap) {
			seriesVistas.add(k);
			agora.push(u);
		} else if (novas.some((n) => chaveSerie(n) === k)) depois.push(u);
		else {
			seriesVistas.add(k);
			novas.push(u);
			depois.push(u);
		}
	}
	await runtime.runPromise(
		Effect.all([aplicar(agora), Effect.forEach(novas, (u) => Metric.value(Metric.withAttributes(u.metrica, u.labels)), { discard: true })], { discard: true })
	);
	if (!depois.length) return;
	if (atrasoSerieNovaMs <= 0) await runtime.runPromise(aplicar(depois));
	else setTimeout(() => void runtime.runPromise(aplicar(depois)).catch(() => {}), atrasoSerieNovaMs);
}

/** The registry's current values, for the tests. */
export const lerMetricas = () => runtime.runPromise(Metric.snapshot);
