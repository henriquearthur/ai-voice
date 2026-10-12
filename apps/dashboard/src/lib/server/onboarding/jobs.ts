import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { JobState, JobView } from '#lib/onboarding/model.js';

/**
 * Tarefas do onboarding em segundo plano. Vivem no processo do servidor do dashboard (que o launchd
 * mantém de pé), então fechar a janela ou recarregar a página não interrompe nada: a página só
 * consulta o estado. O log de cada tarefa também vai para ~/.local/share/jarvis/onboarding/<id>.log.
 */

export type JobContext = {
	log(line: string): void;
	etapa(texto: string): void;
	progresso(valor: number | null): void;
	/** Roda um comando e manda stdout/stderr para o log, linha a linha. Rejeita se o código não for 0. */
	sh(cmd: string, args: ReadonlyArray<string>, opts?: { cwd?: string; env?: Record<string, string> }): Promise<void>;
	readonly signal: AbortSignal;
};

type Job = {
	id: string;
	item: string;
	titulo: string;
	estado: JobState;
	progresso: number | null;
	etapa: string;
	log: string[];
	iniciadoEm: string;
	terminadoEm?: string;
	abort: AbortController;
};

const MAX_LOG = 400;

/** Linhas sem códigos ANSI e sem \r de barras de progresso. */
export function cleanLine(s: string): string {
	// eslint-disable-next-line no-control-regex
	return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\r').pop()!.trimEnd();
}

export class JobRegistry {
	private jobs = new Map<string, Job>();
	constructor(private readonly logDir: string | null) {}

	list(): JobView[] {
		return [...this.jobs.values()].map(view);
	}

	/** A tarefa em curso (ou a última) de um item. */
	latest(item: string): JobView | undefined {
		const all = [...this.jobs.values()].filter((j) => j.item === item);
		const last = all.at(-1);
		return last && view(last);
	}

	running(item: string): boolean {
		return [...this.jobs.values()].some((j) => j.item === item && j.estado === 'rodando');
	}

	start(item: string, titulo: string, run: (ctx: JobContext) => Promise<void>, env: NodeJS.ProcessEnv = process.env): JobView {
		const current = [...this.jobs.values()].find((j) => j.item === item && j.estado === 'rodando');
		if (current) return view(current);
		// Uma tarefa por item: a anterior (terminada) sai da lista.
		for (const [id, j] of this.jobs) if (j.item === item) this.jobs.delete(id);

		const job: Job = {
			id: `${item}-${Date.now().toString(36)}`,
			item,
			titulo,
			estado: 'rodando',
			progresso: null,
			etapa: 'começando',
			log: [],
			iniciadoEm: new Date().toISOString(),
			abort: new AbortController()
		};
		this.jobs.set(job.id, job);
		const file = this.logDir ? join(this.logDir, `${item}.log`) : null;
		if (file) {
			try {
				mkdirSync(this.logDir!, { recursive: true });
				appendFileSync(file, `\n=== ${job.iniciadoEm} ${titulo}\n`);
			} catch {
				/* sem log em disco, segue só em memória */
			}
		}
		const log = (raw: string) => {
			for (const piece of raw.split('\n')) {
				const line = cleanLine(piece);
				if (!line) continue;
				job.log.push(line);
				if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
				if (file) {
					try {
						appendFileSync(file, line + '\n');
					} catch {
						/* idem */
					}
				}
			}
		};
		const ctx: JobContext = {
			log,
			etapa: (t) => {
				job.etapa = t;
				log(`==> ${t}`);
			},
			progresso: (v) => (job.progresso = v === null ? null : Math.max(0, Math.min(1, v))),
			signal: job.abort.signal,
			sh: (cmd, args, opts = {}) =>
				new Promise<void>((resolve, reject) => {
					const child = spawn(cmd, args as string[], {
						cwd: opts.cwd,
						env: { ...env, ...opts.env },
						stdio: ['ignore', 'pipe', 'pipe'],
						signal: job.abort.signal
					});
					let pending = '';
					const onData = (b: Buffer) => {
						pending += b.toString('utf8');
						const parts = pending.split('\n');
						pending = parts.pop() ?? '';
						for (const p of parts) log(p);
					};
					child.stdout.on('data', onData);
					child.stderr.on('data', onData);
					child.on('error', reject);
					child.on('close', (code) => {
						if (pending) log(pending);
						code === 0 ? resolve() : reject(new Error(`${cmd.split('/').pop()} saiu com código ${code}`));
					});
				})
		};
		run(ctx).then(
			() => {
				job.estado = 'ok';
				job.progresso = 1;
				job.etapa = 'pronto';
				job.terminadoEm = new Date().toISOString();
				log('pronto');
			},
			(err: unknown) => {
				job.estado = 'erro';
				job.etapa = err instanceof Error ? err.message : String(err);
				job.terminadoEm = new Date().toISOString();
				log(`erro: ${job.etapa}`);
			}
		);
		return view(job);
	}

	cancel(item: string): void {
		for (const j of this.jobs.values()) if (j.item === item && j.estado === 'rodando') j.abort.abort();
	}
}

function view(j: Job): JobView {
	return {
		id: j.id,
		item: j.item,
		titulo: j.titulo,
		estado: j.estado,
		progresso: j.progresso,
		etapa: j.etapa,
		log: j.log.slice(-200),
		iniciadoEm: j.iniciadoEm,
		...(j.terminadoEm ? { terminadoEm: j.terminadoEm } : {})
	};
}
