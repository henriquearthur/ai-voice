/**
 * The Telemetria tab's view of the Jarvis: what the live collector (`/estado` on 127.0.0.1:7352) says right now,
 * plus the latency percentiles read from Prometheus.
 *
 * The collector's JSON is read through `normalizeEstado`, which accepts a few spellings of each field (pt and en,
 * camelCase and snake_case) and drops anything it cannot read. This is the provisional schema: when the
 * collector's own type (apps/coletor/src/estado.ts, `Retrato`) changes, adjust the readers below and keep `Estado` as the page's contract.
 */

export type Servico = {
	/** Loaded in launchd (false: installed but booted out). Null when unknown. */
	readonly carregado?: boolean | null;
	/** Short name: callback, dashboard, escuta, tts, telemetria… */
	readonly nome: string;
	/** launchd label, such as dev.jarvis.escuta. */
	readonly label: string;
	readonly vivo: boolean;
	readonly pid: number | null;
	readonly reinicios: number | null;
	/** Run by launchd on a schedule (StartInterval/StartCalendarInterval): no PID between runs is normal. */
	readonly periodico?: boolean;
	/** Seconds between runs, for StartInterval; null when unknown or calendar-based. */
	readonly intervaloS?: number | null;
	/** launchd's runs: how many times it started the service. */
	readonly execucoes?: number | null;
	/** Last known run of a periodic service (ms since epoch). */
	readonly ultimaExecucao?: number | null;
	/** Last exit status as launchd reports it ("0", "-9", "(never exited)"…). */
	readonly ultimaSaida?: string | null;
	readonly ramBytes: number | null;
	readonly cpuPct: number | null;
	/** Health check answered (HTTP 200), when the service has one. */
	readonly httpOk: boolean | null;
	readonly healthMs: number | null;
};

/** First integer of launchd's exit status ("0", "-9", "75: EX_TEMPFAIL"); null when it never exited. */
export function codigoSaida(s: string | null | undefined): number | null {
	const m = /^\s*(-?\d+)/.exec(s ?? '');
	return m ? Number(m[1]) : null;
}

export type SaudePeriodico = 'rodando' | 'agendado' | 'falhou' | 'atrasado';

/**
 * A periodic service is healthy between runs: alert only when the last run exited non-zero, or when the last run is
 * older than three intervals.
 */
export function saudePeriodico(s: Servico, agora: number): SaudePeriodico {
	if (s.vivo) return 'rodando';
	const codigo = codigoSaida(s.ultimaSaida);
	if (codigo !== null && codigo !== 0) return 'falhou';
	if (s.intervaloS && s.ultimaExecucao != null && agora - s.ultimaExecucao > 3 * s.intervaloS * 1000) return 'atrasado';
	return 'agendado';
}

export type AgenteEstado = 'working' | 'blocked' | 'idle' | 'done' | 'unknown';

export type Agente = {
	readonly id: string;
	readonly nome: string;
	readonly workspace: string | null;
	readonly estado: AgenteEstado;
	/** When it entered the current state (ms since epoch). */
	readonly desde: number | null;
	readonly ramBytes: number | null;
	readonly cpuPct: number | null;
	/** The agent's session id (Claude Code session), when the collector knows it. */
	readonly sessao: string | null;
	/** Every subagent the agent opened, direct or nested (see `paiId`); empty when there are none. */
	readonly subagentes: ReadonlyArray<Subagente>;
	/** The collector sent the `subagentes` field at all (false: an older collector, so the list says nothing). */
	readonly subagentesPublicados: boolean;
};

/** rodando: working now · parado: alive but quiet · terminou: has ended. */
export type SubagenteEstado = 'rodando' | 'parado' | 'terminou';

export type Subagente = {
	readonly id: string;
	/** The subagent that opened this one; null when the herdr agent itself opened it. */
	readonly paiId: string | null;
	/** Who opened it, as the collector names it (agent or subagent). */
	readonly abertoPor: string | null;
	readonly descricao: string;
	readonly tipo: string | null;
	readonly estado: SubagenteEstado;
	readonly inicio: number | null;
	readonly fim: number | null;
	readonly duracaoS: number | null;
	readonly ultimaAtividadeEm: number | null;
	/** What it is waiting on right now, if anything. */
	readonly aguardando: string | null;
	/** How it ended, in a line. */
	readonly resumoFim: string | null;
};

export type Herdr = {
	/** The herdr server answered. */
	readonly vivo: boolean;
	readonly versao: string | null;
	readonly workspaces: number | null;
	readonly agentes: ReadonlyArray<Agente>;
	readonly erro: string | null;
};

export type Interrupcao = {
	readonly at: number;
	/** What interrupted: fala, painel, novo pedido… */
	readonly motivo: string | null;
	/** What Jarvis was saying when cut. */
	readonly texto: string | null;
	/** From the interruption to the voice actually stopping. */
	readonly killMs: number | null;
};

export type Escuta = {
	readonly pedidos: number | null;
	readonly interrupcoesTotal: number | null;
	readonly entregaMs: Percentis | null;
	/** From the interruption to the voice stopping. */
	readonly killMs: Percentis | null;
	readonly interrupcoes: ReadonlyArray<Interrupcao>;
};

export type Percentis = { readonly p50: number | null; readonly p95: number | null; readonly n?: number | null };

export type Estado = {
	readonly geradoEm: number;
	readonly servicos: ReadonlyArray<Servico>;
	readonly herdr: Herdr | null;
	readonly escuta: Escuta | null;
};

export type Latencia = {
	readonly id: string;
	readonly grupo: 'voz' | 'entrega';
	readonly rotulo: string;
	readonly detalhe: string;
	readonly p50: number | null;
	readonly p95: number | null;
	/** How many samples went into the window. */
	readonly amostras: number | null;
};

export type Ponto = { readonly t: number; readonly cpu: number | null; readonly ram: number | null };

/** What the page receives on load and on every live frame. */
export type Painel = {
	readonly geradoEm: number;
	/** The collector answered with something readable. */
	readonly coletor: 'ok' | 'fora';
	readonly prometheus: 'ok' | 'fora';
	readonly estado: Estado | null;
	/** The probe's last reading of each dev.jarvis.* service from Prometheus; used when the collector is down. */
	readonly servicosProm: ReadonlyArray<Servico>;
	readonly latencias: ReadonlyArray<Latencia>;
	/** Recent CPU/RAM samples per agent id, oldest first. */
	readonly historico: Readonly<Record<string, ReadonlyArray<Ponto>>>;
	/** Where "Abrir painel completo" goes. */
	readonly painelUrl: string;
	/** Collector URL, shown in the empty state. */
	readonly coletorUrl: string;
};

/* ------------------------------------------------------------------------------------------------ */
/* Lenient readers                                                                                   */
/* ------------------------------------------------------------------------------------------------ */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function pick(o: Obj, keys: ReadonlyArray<string>): unknown {
	for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
	return undefined;
}

function num(v: unknown): number | null {
	if (typeof v === 'number' && Number.isFinite(v)) return v;
	if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
	return null;
}

function str(v: unknown): string | null {
	if (typeof v === 'string' && v.trim() !== '') return v;
	if (typeof v === 'number') return String(v);
	return null;
}

function bool(v: unknown): boolean | null {
	if (typeof v === 'boolean') return v;
	if (v === 1 || v === '1' || v === 'true' || v === 'running' || v === 'ok') return true;
	if (v === 0 || v === '0' || v === 'false' || v === 'stopped' || v === 'off') return false;
	return null;
}

/** Seconds or milliseconds since epoch, or an ISO string, to milliseconds. */
function instant(v: unknown): number | null {
	const n = num(v);
	if (n !== null) return n < 1e11 ? n * 1000 : n;
	if (typeof v === 'string') {
		const parsed = Date.parse(v);
		return Number.isNaN(parsed) ? null : parsed;
	}
	return null;
}

function list(v: unknown): Obj[] {
	if (Array.isArray(v)) return v.filter(isObj);
	// A map keyed by name: { escuta: {...}, tts: {...} }.
	if (isObj(v)) return Object.entries(v).flatMap(([k, x]) => (isObj(x) ? [{ __chave: k, ...x }] : []));
	return [];
}

const RAM_BYTES = ['ramBytes', 'ram_bytes', 'rssBytes', 'rss_bytes', 'rss', 'memoria', 'ram'];
const RAM_MB = ['ramMb', 'ram_mb', 'rssMb', 'rss_mb'];
const CPU = ['cpuPct', 'cpu_pct', 'cpu', 'cpuPercent'];

function ram(o: Obj): number | null {
	const bytes = num(pick(o, RAM_BYTES));
	if (bytes !== null) return bytes;
	const mb = num(pick(o, RAM_MB));
	return mb === null ? null : mb * 1024 * 1024;
}

function servico(o: Obj): Servico | null {
	const label = str(pick(o, ['label', 'servicoLabel', 'launchd'])) ?? null;
	const nome =
		str(pick(o, ['servico', 'nome', 'name', '__chave'])) ?? (label ? label.replace(/^dev\.jarvis\./, '') : null);
	if (!nome) return null;
	const pid = num(pick(o, ['pid']));
	const carregado = bool(pick(o, ['carregado', 'loaded']));
	const vivo = bool(pick(o, ['vivo', 'alive', 'up', 'rodando', 'running', 'estado', 'state'])) ?? pid !== null;
	const periodico = bool(pick(o, ['periodico', 'periodic'])) ?? false;
	return {
		carregado,
		nome: nome.replace(/^dev\.jarvis\./, ''),
		label: label ?? (nome.startsWith('dev.jarvis.') ? nome : `dev.jarvis.${nome}`),
		vivo,
		pid,
		reinicios: num(pick(o, ['reinicios', 'restarts'])) ?? (periodico ? null : num(pick(o, ['execucoes', 'runs']))),
		periodico,
		intervaloS: num(pick(o, ['intervalo_s', 'intervaloS', 'interval_s'])),
		execucoes: num(pick(o, ['execucoes', 'runs'])),
		ultimaExecucao: instant(pick(o, ['ultima_execucao_em', 'ultimaExecucao', 'last_run'])),
		ultimaSaida: str(pick(o, ['ultima_saida', 'ultimaSaida', 'last_exit'])),
		ramBytes: ram(o),
		cpuPct: num(pick(o, CPU)),
		httpOk: bool(pick(o, ['httpOk', 'http_ok', 'saudavel', 'healthy'])),
		healthMs: num(pick(o, ['healthMs', 'health_ms', 'latenciaMs']))
	};
}

function agenteEstado(v: unknown): AgenteEstado {
	const s = typeof v === 'string' ? v.toLowerCase() : '';
	if (['working', 'trabalhando', 'busy', 'running'].includes(s)) return 'working';
	if (['blocked', 'bloqueado', 'waiting', 'aguardando', 'needs_input'].includes(s)) return 'blocked';
	if (['idle', 'ocioso', 'parado'].includes(s)) return 'idle';
	if (['done', 'pronto', 'concluido', 'concluído', 'finished'].includes(s)) return 'done';
	return 'unknown';
}

function subagenteEstado(v: unknown, fim: number | null): SubagenteEstado {
	const s = typeof v === 'string' ? v.toLowerCase() : '';
	if (['rodando', 'running', 'working', 'ativo', 'active'].includes(s)) return 'rodando';
	if (['parado', 'stalled', 'idle', 'ocioso', 'waiting', 'aguardando'].includes(s)) return 'parado';
	if (['terminou', 'terminado', 'done', 'finished', 'completed', 'concluido', 'concluído', 'stopped', 'failed'].includes(s)) return 'terminou';
	return fim === null ? 'rodando' : 'terminou';
}

function subagente(o: Obj): Subagente | null {
	const id = str(pick(o, ['id', 'agent_id', 'agentId', 'tool_use_id', '__chave']));
	if (!id) return null;
	const inicio = instant(pick(o, ['inicio', 'start', 'started_at', 'startedAt']));
	const fim = instant(pick(o, ['fim', 'end', 'ended_at', 'endedAt']));
	const tipo = str(pick(o, ['tipo', 'type', 'subagent_type', 'subagentType']));
	return {
		id,
		paiId: str(pick(o, ['pai_id', 'paiId', 'parent_id', 'parentId'])),
		abertoPor: str(pick(o, ['aberto_por', 'abertoPor', 'opened_by', 'openedBy'])),
		descricao: str(pick(o, ['descricao', 'description', 'titulo', 'title'])) ?? tipo ?? id,
		tipo,
		estado: subagenteEstado(pick(o, ['estado', 'state', 'status']), fim),
		inicio,
		fim,
		duracaoS: num(pick(o, ['duracao_s', 'duracaoS', 'duration_s'])),
		ultimaAtividadeEm: instant(pick(o, ['ultima_atividade_em', 'ultimaAtividadeEm', 'last_activity_at'])),
		aguardando: str(pick(o, ['aguardando', 'waiting_on', 'waitingOn'])),
		resumoFim: str(pick(o, ['resumo_fim', 'resumoFim', 'summary']))
	};
}

function agente(o: Obj, now: number, workspace: string | null): Agente | null {
	const id = str(pick(o, ['id', 'pane', 'pane_id', 'agente', 'nome', 'name', '__chave']));
	if (!id) return null;
	const desdeDireto = instant(pick(o, ['desde', 'since', 'estadoDesde', 'estado_desde', 'changedAt']));
	const noEstadoS = num(pick(o, ['segundos_no_estado', 'tempoNoEstadoS', 'tempo_no_estado_s', 'segundosNoEstado']));
	// The agent's own process plus what it spawned (node, git, builds): what it really costs the Mac.
	const filhos = pick(o, ['filhos', 'children']);
	const somar = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : a + b);
	const noEstadoMs = num(pick(o, ['tempoNoEstadoMs', 'tempo_no_estado_ms', 'noEstadoMs']));
	const subsRaw = pick(o, ['subagentes', 'subagents']);
	const subs = Array.isArray(subsRaw) ? subsRaw.filter(isObj) : [];
	return {
		id,
		nome: str(pick(o, ['nome', 'name', 'titulo', 'title', 'agente'])) ?? id,
		workspace: str(pick(o, ['workspace', 'workspaceNome', 'ws'])) ?? workspace,
		estado: agenteEstado(pick(o, ['estado', 'state', 'status'])),
		desde: desdeDireto ?? (noEstadoMs !== null ? now - noEstadoMs : noEstadoS !== null ? now - noEstadoS * 1000 : null),
		ramBytes: somar(ram(o), isObj(filhos) ? ram(filhos) : null),
		cpuPct: somar(num(pick(o, CPU)), isObj(filhos) ? num(pick(filhos, CPU)) : null),
		sessao: str(pick(o, ['sessao', 'session', 'session_id', 'sessionId'])),
		subagentes: subs.map(subagente).filter((x): x is Subagente => x !== null),
		subagentesPublicados: subsRaw !== undefined
	};
}

function herdr(v: unknown, now: number): Herdr | null {
	if (!isObj(v)) return null;
	const ws = pick(v, ['workspaces']);
	const agentes: Agente[] = [];
	// Workspaces may come as a list holding their agents, or as a count beside a flat agent list.
	for (const w of Array.isArray(ws) ? list(ws) : []) {
		const nomeWs = str(pick(w, ['nome', 'name', 'id', '__chave']));
		for (const a of list(pick(w, ['agentes', 'agents', 'panes']))) {
			const parsed = agente(a, now, nomeWs);
			if (parsed) agentes.push(parsed);
		}
	}
	for (const a of list(pick(v, ['agentes', 'agents']))) {
		const parsed = agente(a, now, null);
		if (parsed && !agentes.some((x) => x.id === parsed.id)) agentes.push(parsed);
	}
	return {
		vivo: bool(pick(v, ['vivo', 'alive', 'up'])) ?? true,
		versao: str(pick(v, ['versao', 'version'])),
		workspaces: Array.isArray(ws) ? ws.length : num(ws),
		agentes,
		erro: str(pick(v, ['erro', 'error']))
	};
}

function percentis(v: unknown): Percentis | null {
	if (!isObj(v)) return null;
	const p50 = num(pick(v, ['p50', 'mediana', 'p50Ms', 'p50_ms']));
	const p95 = num(pick(v, ['p95', 'p95Ms', 'p95_ms']));
	if (num(pick(v, ['amostras', 'n', 'count'])) === 0) return null;
	if (p50 === null && p95 === null) return null;
	return { p50, p95, n: num(pick(v, ['n', 'amostras', 'count'])) };
}

function interrupcao(o: Obj): Interrupcao | null {
	const at = instant(pick(o, ['at', 'ts', 'em', 'timestamp', 'quando']));
	if (at === null) return null;
	const dono = str(pick(o, ['owner', 'motivo', 'reason', 'origem']));
	return {
		at,
		motivo: dono ? `voz: ${dono}` : null,
		texto: str(pick(o, ['heard', 'texto', 'text', 'fala'])),
		killMs: num(pick(o, ['kill_ms', 'killMs', 'paradaMs']))
	};
}

function escuta(v: unknown): Escuta | null {
	if (!isObj(v)) return null;
	const lat = pick(v, ['latencias', 'latencies']);
	const contadores = pick(v, ['contadores', 'counters']);
	const c = isObj(contadores) ? contadores : v;
	const explicitas = list(pick(v, ['interrupcoes', 'interruptions', 'ultimasInterrupcoes']));
	// The collector keeps the escuta's last events; the barge_in ones are the interruptions.
	const dosEventos = list(pick(v, ['ultimos_eventos', 'eventos'])).filter((e) => pick(e, ['type', 'tipo']) === 'barge_in');
	const interrupcoes = [...explicitas, ...dosEventos]
		.map(interrupcao)
		.filter((i): i is Interrupcao => i !== null)
		.sort((a, b) => b.at - a.at);
	const pedidos = pick(c, ['pedidos', 'requests']);
	return {
		pedidos: num(isObj(pedidos) ? pick(pedidos, ['total', 'hoje']) : pedidos),
		interrupcoesTotal: num(Array.isArray(pick(c, ['interrupcoes'])) ? null : pick(c, ['interrupcoes', 'interrupcoesTotal', 'interrupcoes_total'])),
		entregaMs: percentis(pick(v, ['entrega_ms', 'entregaMs']) ?? (isObj(lat) ? pick(lat, ['entrega', 'entregaMs', 'delivery']) : pick(v, ['entrega']))),
		killMs: percentis(pick(v, ['interrupcao_kill_ms', 'killMs'])),
		interrupcoes
	};
}

/** Reads whatever the collector sent; null when it is not an object at all. */
export function normalizeEstado(raw: unknown, now = Date.now()): Estado | null {
	if (!isObj(raw)) return null;
	const servicos = list(pick(raw, ['servicos', 'services']))
		.map(servico)
		.filter((s): s is Servico => s !== null);
	return {
		geradoEm: instant(pick(raw, ['geradoEm', 'gerado_em', 'at', 'ts', 'timestamp'])) ?? now,
		servicos,
		herdr: herdr(pick(raw, ['herdr']), now),
		escuta: escuta(pick(raw, ['escuta']))
	};
}

/* ------------------------------------------------------------------------------------------------ */
/* Formatting                                                                                        */
/* ------------------------------------------------------------------------------------------------ */

const oneDecimal = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });

/** 312 MB · 1,4 GB */
export function bytes(n: number | null): string {
	if (n === null) return '—';
	const mb = n / (1024 * 1024);
	if (mb < 1) return `${whole.format(n / 1024)} KB`;
	if (mb < 1024) return `${whole.format(mb)} MB`;
	return `${oneDecimal.format(mb / 1024)} GB`;
}

export const pct = (n: number | null) => (n === null ? '—' : `${oneDecimal.format(n)}%`);

export const ESTADO_ROTULO: Record<AgenteEstado, string> = {
	working: 'Trabalhando',
	blocked: 'Esperando você',
	idle: 'Ocioso',
	done: 'Concluído',
	unknown: 'Sem estado'
};

/** Order on screen: what needs attention first. */
export const ESTADO_ORDEM: Record<AgenteEstado, number> = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 };

/** A subagent still going: running, or alive and quiet. */
export const subagenteAtivo = (s: Subagente) => s.estado !== 'terminou' && s.fim === null;

export type NoSubagente = {
	readonly sub: Subagente;
	readonly filhos: ReadonlyArray<NoSubagente>;
	/** Itself or anything under it is still going: shown open, above the finished ones. */
	readonly ativo: boolean;
};

const SUB_ORDEM: Record<SubagenteEstado, number> = { rodando: 0, parado: 1, terminou: 2 };

/**
 * The flat list as a tree: the agent's direct subagents at the root, each holding the ones it opened.
 * A `paiId` that names nobody in the list (or names the agent itself) puts the subagent at the root; cycles are cut.
 * Each level: what is still going first (running before quiet, oldest first), then the finished, newest first.
 */
export function arvoreSubagentes(subs: ReadonlyArray<Subagente>): NoSubagente[] {
	const porId = new Map(subs.map((s) => [s.id, s]));
	const filhosDe = new Map<string | null, Subagente[]>();
	for (const s of subs) {
		const pai = s.paiId !== null && s.paiId !== s.id && porId.has(s.paiId) ? s.paiId : null;
		filhosDe.set(pai, [...(filhosDe.get(pai) ?? []), s]);
	}
	const visto = new Set<string>();
	const montar = (pai: string | null): NoSubagente[] =>
		(filhosDe.get(pai) ?? [])
			.filter((s) => !visto.has(s.id) && (visto.add(s.id), true))
			.map((sub) => {
				const filhos = montar(sub.id);
				return { sub, filhos, ativo: subagenteAtivo(sub) || filhos.some((f) => f.ativo) };
			})
			.sort((a, b) =>
				a.ativo !== b.ativo
					? (a.ativo ? -1 : 1)
					: a.ativo
						? SUB_ORDEM[a.sub.estado] - SUB_ORDEM[b.sub.estado] || (a.sub.inicio ?? 0) - (b.sub.inicio ?? 0)
						: (b.sub.fim ?? b.sub.inicio ?? 0) - (a.sub.fim ?? a.sub.inicio ?? 0)
			);
	const raizes = montar(null);
	// Whatever a cycle left out still shows, at the root.
	for (const s of subs) if (!visto.has(s.id)) raizes.push({ sub: s, filhos: [], ativo: subagenteAtivo(s) });
	return raizes;
}

/** Counts across the whole tree, for the agent's header. */
export function contarSubagentes(subs: ReadonlyArray<Subagente>) {
	const ativos = subs.filter(subagenteAtivo);
	return {
		rodando: ativos.filter((s) => s.estado === 'rodando').length,
		parados: ativos.filter((s) => s.estado !== 'rodando').length,
		concluidos: subs.length - ativos.length,
		total: subs.length
	};
}

export const SUBAGENTE_ROTULO: Record<SubagenteEstado, string> = { rodando: 'Rodando', parado: 'Parado', terminou: 'Concluído' };

export const vazio = (painelUrl: string, coletorUrl: string): Painel => ({
	geradoEm: Date.now(),
	coletor: 'fora',
	prometheus: 'fora',
	estado: null,
	servicosProm: [],
	latencias: [],
	historico: {},
	painelUrl,
	coletorUrl
});
