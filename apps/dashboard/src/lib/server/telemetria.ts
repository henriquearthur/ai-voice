import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Estado, type Interrupcao, type Latencia, type Painel, type Ponto, type Servico, normalizeEstado } from '#lib/telemetria/model.js';

/**
 * The Telemetria tab's server side. It reads three local things and never writes anywhere:
 *   - the live collector (GET /estado and SSE /estado/ao-vivo, 127.0.0.1:7352 by default);
 *   - Prometheus (127.0.0.1:9090) for the latency percentiles and to seed the agents' sparklines;
 *   - ~/.config/jarvis/jarvis.env for JARVIS_TELEMETRIA_URL, JARVIS_COLETOR_URL and JARVIS_PROMETHEUS_URL.
 * Any of them missing reads as an empty panel, never as an error.
 */

const CONFIG = process.env.JARVIS_CONFIG ?? join(homedir(), '.config/jarvis/jarvis.env');
const DEFAULTS = {
	JARVIS_TELEMETRIA_URL: 'http://127.0.0.1:7351/d/jarvis',
	JARVIS_COLETOR_URL: 'http://127.0.0.1:7352',
	JARVIS_PROMETHEUS_URL: 'http://127.0.0.1:9090'
} as const;
type ConfigKey = keyof typeof DEFAULTS;
export type TelemetriaConfig = { painelUrl: string; coletorUrl: string; prometheusUrl: string };

const HISTORY_MS = 15 * 60_000;
const SAMPLE_EVERY_MS = 5000;
const PROMETHEUS_EVERY_MS = 15_000;

/** KEY="value" lines from the env file; comments and anything else are ignored. */
async function readEnvFile(): Promise<Partial<Record<ConfigKey, string>>> {
	let text: string;
	try {
		text = await readFile(CONFIG, 'utf8');
	} catch {
		return {};
	}
	const out: Partial<Record<ConfigKey, string>> = {};
	for (const line of text.split('\n')) {
		const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
		if (!m || !(m[1] in DEFAULTS)) continue;
		const value = m[2].replace(/^(['"])(.*)\1$/, '$2').trim();
		if (value) out[m[1] as ConfigKey] = value;
	}
	return out;
}

const httpUrl = (v: string | undefined) => {
	if (!v) return null;
	try {
		const u = new URL(v);
		return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString().replace(/\/$/, '') : null;
	} catch {
		return null;
	}
};

let configCache: { at: number; value: TelemetriaConfig } | null = null;

export async function readConfig(): Promise<TelemetriaConfig> {
	if (configCache && Date.now() - configCache.at < 30_000) return configCache.value;
	const file = await readEnvFile();
	const get = (k: ConfigKey) => httpUrl(process.env[k]) ?? httpUrl(file[k]) ?? DEFAULTS[k];
	const value = {
		painelUrl: get('JARVIS_TELEMETRIA_URL'),
		coletorUrl: get('JARVIS_COLETOR_URL'),
		prometheusUrl: get('JARVIS_PROMETHEUS_URL')
	};
	configCache = { at: Date.now(), value };
	return value;
}

/* ------------------------------------------------------------------------------------------------ */
/* Collector                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

/** The collector's raw JSON, or null when it is down or answers something that is not JSON. */
export async function fetchEstadoRaw(coletorUrl: string): Promise<unknown | null> {
	try {
		const res = await fetch(`${coletorUrl}/estado`, { signal: AbortSignal.timeout(1500), headers: { accept: 'application/json' } });
		if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
		return await res.json();
	} catch {
		return null;
	}
}

/* ------------------------------------------------------------------------------------------------ */
/* Prometheus                                                                                        */
/* ------------------------------------------------------------------------------------------------ */

type Vector = Array<{ metric: Record<string, string>; value: [number, string] }>;
type Matrix = Array<{ metric: Record<string, string>; values: Array<[number, string]> }>;

async function promQuery(base: string, query: string): Promise<Vector | null> {
	try {
		const res = await fetch(`${base}/api/v1/query?${new URLSearchParams({ query })}`, { signal: AbortSignal.timeout(2500) });
		if (!res.ok) return null;
		const body = (await res.json()) as { status: string; data?: { resultType: string; result: Vector } };
		return body.status === 'success' && body.data?.resultType === 'vector' ? body.data.result : null;
	} catch {
		return null;
	}
}

async function promRange(base: string, query: string, seconds: number, step: number): Promise<Matrix | null> {
	const end = Math.floor(Date.now() / 1000);
	try {
		const params = new URLSearchParams({ query, start: String(end - seconds), end: String(end), step: String(step) });
		const res = await fetch(`${base}/api/v1/query_range?${params}`, { signal: AbortSignal.timeout(4000) });
		if (!res.ok) return null;
		const body = (await res.json()) as { status: string; data?: { resultType: string; result: Matrix } };
		return body.status === 'success' && body.data?.resultType === 'matrix' ? body.data.result : null;
	} catch {
		return null;
	}
}

const scalar = (v: Vector | null): number | null => {
	const raw = v?.[0]?.value?.[1];
	const n = raw === undefined ? NaN : Number(raw);
	return Number.isFinite(n) ? n : null;
};

/** The histograms behind "Latência": what the voice and the deliveries take, last hour. */
const SERIES: ReadonlyArray<Omit<Latencia, 'p50' | 'p95' | 'amostras'> & { metric: string }> = [
	{ id: 'tts-primeiro-audio', grupo: 'voz', rotulo: 'Primeiro áudio', detalhe: 'servidor de voz, do pedido ao 1º trecho', metric: 'jarvis_tts_primeiro_audio_ms' },
	{ id: 'tts-sintese', grupo: 'voz', rotulo: 'Síntese completa', detalhe: 'servidor de voz, frase inteira', metric: 'jarvis_tts_sintese_ms' },
	{ id: 'voz-ate-audio', grupo: 'voz', rotulo: 'Até tocar', detalhe: 'do speak ao som saindo', metric: 'jarvis_voz_ate_audio_ms' },
	{ id: 'escuta-entrega', grupo: 'entrega', rotulo: 'Pedido entregue', detalhe: 'da fala ao agente receber', metric: 'jarvis_escuta_entrega_ms' },
	{ id: 'grokbot-entrega', grupo: 'entrega', rotulo: 'Grok Bot', detalhe: 'entrega da resposta', metric: 'jarvis_grokbot_entrega_ms' }
];

async function readLatencias(base: string): Promise<{ ok: boolean; latencias: Latencia[] }> {
	const window = '1h';
	const results = await Promise.all(
		SERIES.map(async ({ metric, ...rest }) => {
			const q = (p: number) => `histogram_quantile(${p}, sum by (le) (rate(${metric}_bucket[${window}])))`;
			const [p50, p95, n] = await Promise.all([
				promQuery(base, q(0.5)),
				promQuery(base, q(0.95)),
				promQuery(base, `sum(increase(${metric}_count[${window}]))`)
			]);
			return { reached: p50 !== null, value: { ...rest, p50: scalar(p50), p95: scalar(p95), amostras: scalar(n) } };
		})
	);
	return { ok: results.some((r) => r.reached), latencias: results.map((r) => r.value) };
}

/** The probe's gauges (jarvis_servico_*{servico}), one card per service, in case the collector is down. */
async function readServicosProm(base: string): Promise<Servico[]> {
	const campos = ['vivo', 'execucoes', 'http_ok', 'health_ms', 'rss_bytes', 'cpu_pct'] as const;
	const results = await Promise.all(campos.map((c) => promQuery(base, `max by (servico) (last_over_time(jarvis_servico_${c}[2m]))`)));
	const por = new Map<string, Partial<Record<(typeof campos)[number], number>>>();
	results.forEach((vector, i) => {
		for (const { metric, value } of vector ?? []) {
			if (!metric.servico) continue;
			const n = Number(value[1]);
			if (!Number.isFinite(n)) continue;
			const row = por.get(metric.servico) ?? {};
			row[campos[i]] = n;
			por.set(metric.servico, row);
		}
	});
	return [...por.entries()].map(([nome, r]) => ({
		nome,
		label: nome === 'grafana' || nome === 'otlp' ? `contêiner jarvis-telemetria` : `dev.jarvis.${nome}`,
		vivo: (r.vivo ?? 0) > 0,
		pid: null,
		// execucoes counts launches; the first one is not a restart.
		reinicios: r.execucoes === undefined ? null : Math.max(0, r.execucoes - 1),
		ramBytes: r.rss_bytes ?? null,
		cpuPct: r.cpu_pct ?? null,
		httpOk: r.http_ok === undefined ? null : r.http_ok > 0,
		healthMs: r.health_ms ?? null
	}));
}

async function seedHistory(base: string): Promise<Map<string, Ponto[]>> {
	const out = new Map<string, Ponto[]>();
	const [cpu, rss] = await Promise.all([
		promRange(base, 'sum by (agente) (jarvis_herdr_agente_cpu_pct)', HISTORY_MS / 1000, SAMPLE_EVERY_MS / 1000 * 3),
		promRange(base, 'sum by (agente) (jarvis_herdr_agente_rss_bytes)', HISTORY_MS / 1000, SAMPLE_EVERY_MS / 1000 * 3)
	]);
	const byAgent = new Map<string, Map<number, { cpu: number | null; ram: number | null }>>();
	const add = (m: Matrix | null, field: 'cpu' | 'ram') => {
		for (const series of m ?? []) {
			const agente = series.metric.agente;
			if (!agente) continue;
			const points = byAgent.get(agente) ?? new Map();
			for (const [t, v] of series.values) {
				const n = Number(v);
				const p = points.get(t) ?? { cpu: null, ram: null };
				p[field] = Number.isFinite(n) ? n : null;
				points.set(t, p);
			}
			byAgent.set(agente, points);
		}
	};
	add(cpu, 'cpu');
	add(rss, 'ram');
	for (const [agente, points] of byAgent) {
		out.set(
			agente,
			[...points.entries()].sort((a, b) => a[0] - b[0]).map(([t, p]) => ({ t: t * 1000, ...p }))
		);
	}
	return out;
}

/* ------------------------------------------------------------------------------------------------ */
/* Live: one watcher for every open page                                                             */
/* ------------------------------------------------------------------------------------------------ */

type Listener = (painel: Painel) => void;
const listeners = new Set<Listener>();

let estado: Estado | null = null;
let prometheusOk = false;
let latencias: Latencia[] = [];
let servicosProm: Servico[] = [];
let history = new Map<string, Ponto[]>();
let seeded = false;
let lastPush = '';
let running = false;
let abort: AbortController | null = null;
let promTimer: ReturnType<typeof setInterval> | undefined;

/** The collector only keeps the escuta's last 20 events; interruptions seen are kept here so the list grows. */
let interrupcoesVistas: Interrupcao[] = [];

function lembrarInterrupcoes(next: Estado): Estado {
	if (!next.escuta) return next;
	const porInstante = new Map(interrupcoesVistas.map((i) => [i.at, i]));
	for (const i of next.escuta.interrupcoes) porInstante.set(i.at, i);
	interrupcoesVistas = [...porInstante.values()].sort((a, b) => b.at - a.at).slice(0, 30);
	return { ...next, escuta: { ...next.escuta, interrupcoes: interrupcoesVistas } };
}

function record(next: Estado) {
	const now = Date.now();
	for (const a of next.herdr?.agentes ?? []) {
		const key = history.has(a.id) ? a.id : history.has(a.nome) ? a.nome : a.id;
		const points = history.get(key) ?? [];
		const last = points.at(-1);
		if (!last || now - last.t >= SAMPLE_EVERY_MS) points.push({ t: now, cpu: a.cpuPct, ram: a.ramBytes });
		while (points.length && now - points[0].t > HISTORY_MS) points.shift();
		history.set(key, points);
	}
}

async function painel(): Promise<Painel> {
	const config = await readConfig();
	const ids = new Set((estado?.herdr?.agentes ?? []).flatMap((a) => [a.id, a.nome]));
	const historico: Record<string, Ponto[]> = {};
	for (const [k, v] of history) if (ids.has(k)) historico[k] = v;
	return {
		geradoEm: Date.now(),
		coletor: estado ? 'ok' : 'fora',
		prometheus: prometheusOk ? 'ok' : 'fora',
		estado,
		servicosProm,
		latencias,
		historico,
		painelUrl: config.painelUrl,
		coletorUrl: config.coletorUrl
	};
}

/** Pushes only when the content changed (timestamps aside), and at most once a second. */
const PUSH_EVERY_MS = 1000;
let lastPushAt = 0;
let pushTimer: ReturnType<typeof setTimeout> | undefined;

async function pushNow() {
	pushTimer = undefined;
	const p = await painel();
	const signature = JSON.stringify({ ...p, geradoEm: 0, estado: p.estado && { ...p.estado, geradoEm: 0 } });
	if (signature === lastPush) return;
	lastPush = signature;
	lastPushAt = Date.now();
	for (const l of listeners) l(p);
}

function push() {
	if (pushTimer) return;
	pushTimer = setTimeout(() => void pushNow(), Math.max(0, PUSH_EVERY_MS - (Date.now() - lastPushAt)));
}

function accept(raw: unknown) {
	const lido = normalizeEstado(raw);
	if (!lido) return;
	const next = lembrarInterrupcoes(lido);
	estado = next;
	record(next);
	push();
}

async function refreshPrometheus() {
	const { prometheusUrl } = await readConfig();
	const [read, servicos] = await Promise.all([readLatencias(prometheusUrl), readServicosProm(prometheusUrl)]);
	servicosProm = servicos;
	prometheusOk = read.ok || servicos.length > 0;
	latencias = read.latencias;
	if (read.ok && !seeded) {
		seeded = true;
		const seed = await seedHistory(prometheusUrl);
		for (const [k, points] of seed) {
			const live = history.get(k) ?? [];
			const firstLive = live[0]?.t ?? Infinity;
			history.set(k, [...points.filter((p) => p.t < firstLive), ...live]);
		}
	}
	push();
}

/** Follows the collector's SSE; when it is not there, polls /estado and tries the stream again. */
async function follow() {
	while (running) {
		const { coletorUrl } = await readConfig();
		abort = new AbortController();
		try {
			const res = await fetch(`${coletorUrl}/estado/ao-vivo`, { signal: abort.signal, headers: { accept: 'text/event-stream' } });
			if (!res.ok || !res.body || !(res.headers.get('content-type') ?? '').includes('event-stream')) throw new Error('sem SSE');
			const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
			let buffer = '';
			while (running) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += value;
				let cut: number;
				while ((cut = buffer.indexOf('\n\n')) >= 0) {
					const frame = buffer.slice(0, cut);
					buffer = buffer.slice(cut + 2);
					const data = frame
						.split('\n')
						.filter((l) => l.startsWith('data:'))
						.map((l) => l.slice(5).trimStart())
						.join('\n');
					if (!data) continue;
					try {
						accept(JSON.parse(data));
					} catch {
						// A broken frame: the next one replaces it.
					}
				}
			}
		} catch {
			// No stream: one plain read keeps the page current until the stream comes back.
			if (!running) break;
			const raw = await fetchEstadoRaw(coletorUrl);
			if (raw === null) {
				if (estado) {
					estado = null;
					push();
				}
			} else accept(raw);
		}
		if (running) await new Promise((r) => setTimeout(r, estado ? 2000 : 3000));
	}
}

function start() {
	if (running) return;
	running = true;
	void follow();
	void refreshPrometheus();
	promTimer = setInterval(() => void refreshPrometheus(), PROMETHEUS_EVERY_MS);
}

function stop() {
	running = false;
	abort?.abort();
	abort = null;
	if (promTimer) clearInterval(promTimer);
	promTimer = undefined;
	if (pushTimer) clearTimeout(pushTimer);
	pushTimer = undefined;
	lastPush = '';
}

/** Calls `listener` now and on every change. Returns the unsubscribe function. */
export function watchTelemetria(listener: Listener): () => void {
	listeners.add(listener);
	start();
	void painel().then((p) => listeners.has(listener) && listener(p));
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) stop();
	};
}

/** First paint: a direct read, so the page is never blank while the watcher warms up. */
export async function readPainel(): Promise<Painel> {
	const config = await readConfig();
	const [raw, lat, servicos] = await Promise.all([
		running && estado ? Promise.resolve(undefined) : fetchEstadoRaw(config.coletorUrl),
		running && latencias.length ? Promise.resolve(null) : readLatencias(config.prometheusUrl),
		running ? Promise.resolve(null) : readServicosProm(config.prometheusUrl)
	]);
	if (servicos) servicosProm = servicos;
	if (raw !== undefined) {
		// Nobody watching (or nothing yet): this read is the truth, including "collector down".
		const lido = normalizeEstado(raw);
		estado = lido ? lembrarInterrupcoes(lido) : null;
		if (estado) record(estado);
	}
	if (lat) {
		prometheusOk = lat.ok || servicosProm.length > 0;
		latencias = lat.latencias;
	}
	return painel();
}

import.meta.hot?.dispose(() => {
	stop();
	listeners.clear();
	history = new Map();
	seeded = false;
});
