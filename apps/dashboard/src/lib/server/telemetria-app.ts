import { readConfig } from './telemetria.js';
import type { AppWeb } from '#lib/telemetria/web/app.js';

/**
 * The "App" section of the Telemetria tab: the frontend's own numbers (`jarvis_web_*`, service
 * `jarvis-dashboard-web`), last hour, read from the local Prometheus like the other sections.
 */

async function escalar(base: string, query: string): Promise<{ ok: boolean; valor: number | null }> {
	try {
		const res = await fetch(`${base}/api/v1/query?${new URLSearchParams({ query })}`, { signal: AbortSignal.timeout(2500) });
		if (!res.ok) return { ok: false, valor: null };
		const body = (await res.json()) as { status: string; data?: { result?: Array<{ value: [number, string] }> } };
		if (body.status !== 'success') return { ok: false, valor: null };
		const n = Number(body.data?.result?.[0]?.value?.[1]);
		return { ok: true, valor: Number.isFinite(n) ? n : null };
	} catch {
		return { ok: false, valor: null };
	}
}

const JANELA = '1h';
const p75 = (metric: string, filtro = '') => `histogram_quantile(0.75, sum by (le) (increase(${metric}_bucket${filtro}[${JANELA}])))`;
const soma = (metric: string) => `sum(increase(${metric}[${JANELA}]))`;

export async function readAppWeb(): Promise<AppWeb> {
	const { prometheusUrl } = await readConfig();
	const [lcp, inp, navegacao, erros, reconexoes, descartes, atraso, heap, lotes] = await Promise.all([
		escalar(prometheusUrl, p75('jarvis_web_vital_ms', '{metrica="LCP"}')),
		escalar(prometheusUrl, p75('jarvis_web_vital_ms', '{metrica="INP"}')),
		escalar(prometheusUrl, p75('jarvis_web_navegacao_ms')),
		escalar(prometheusUrl, soma('jarvis_web_erros_total')),
		escalar(prometheusUrl, soma('jarvis_web_sse_reconexoes_total')),
		escalar(prometheusUrl, soma('jarvis_web_sse_descartados_total')),
		escalar(prometheusUrl, p75('jarvis_web_sse_atraso_ms')),
		escalar(prometheusUrl, `max(last_over_time(jarvis_web_heap_bytes[${JANELA}]))`),
		escalar(prometheusUrl, `sum(count_over_time(jarvis_web_lotes_total[${JANELA}]))`)
	]);
	const inteiro = (v: number | null) => (v === null ? null : Math.round(v));
	return {
		prometheus: lcp.ok ? 'ok' : 'fora',
		lcpP75: lcp.valor,
		inpP75: inp.valor,
		navegacaoP75: navegacao.valor,
		atrasoLiveP75: atraso.valor,
		// No series yet reads as nothing measured; once the app reported, zero means zero.
		erros: inteiro(erros.valor) ?? (lotes.valor ? 0 : null),
		reconexoes: inteiro(reconexoes.valor) ?? (lotes.valor ? 0 : null),
		descartes: inteiro(descartes.valor) ?? (lotes.valor ? 0 : null),
		heapBytes: heap.valor,
		ativo: (lotes.valor ?? 0) > 0,
		geradoEm: Date.now()
	};
}
