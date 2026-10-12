import { NodeServices } from '@effect/platform-node';
import { Context, Effect, Layer, Metric, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import {
	CAUDA_LINHAS,
	TECLAS,
	TECLAS_PERMITIDAS,
	limparTerminal,
	parseAgentes,
	parseModo,
	validarTexto,
	type Acao,
	type AgenteCard,
	type AgenteVivo
} from '../agentes/model.ts';

/**
 * Controle remoto dos agentes do herdr pelo CLI. Só dois caminhos escrevem num terminal:
 * `pane send-text` (o texto do steer) e `pane send-keys` (teclas da lista branca). O pane nunca
 * vem do cliente sem passar por `herdr agent list`, e o processo é lançado sem shell.
 */

export const HERDR_BIN = process.env.JARVIS_HERDR_BIN ?? `${process.env.HOME ?? ''}/.local/bin/herdr`;
const TIMEOUT_MS = 5000;

export class HerdrErro extends Schema.TaggedError<HerdrErro>()('HerdrErro', {
	message: Schema.String,
	motivo: Schema.Literals(['cli', 'pane', 'tecla', 'texto'])
}) {}

/** O único ponto que toca o processo: recebe os argumentos já montados e devolve a saída. */
export class HerdrCli extends Context.Service<HerdrCli, {
	readonly run: (args: ReadonlyArray<string>) => Effect.Effect<string, HerdrErro>
}>()('@jarvis/dashboard/HerdrCli') {
	static readonly layer: Layer.Layer<HerdrCli, never, ChildProcessSpawner.ChildProcessSpawner> = Layer.effect(
		HerdrCli,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			return HerdrCli.of({
				run: (args) =>
					spawner
						.string(ChildProcess.make(HERDR_BIN, [...args], { stdin: 'ignore', stderr: 'pipe', forceKillAfter: '1 second' }), {
							includeStderr: true
						})
						.pipe(
							Effect.timeout(TIMEOUT_MS),
							Effect.mapError(() => new HerdrErro({ motivo: 'cli', message: 'O herdr não respondeu.' })),
							Effect.flatMap((saida) =>
								/^\s*\{"error":/.test(saida)
									? Effect.fail(new HerdrErro({ motivo: 'cli', message: mensagemDoCli(saida) }))
									: Effect.succeed(saida)
							)
						)
			});
		})
	);

	static readonly layerNode = HerdrCli.layer.pipe(Layer.provide(NodeServices.layer));
}

const mensagemDoCli = (saida: string): string => {
	try {
		const m = (JSON.parse(saida) as { error?: { message?: unknown } }).error?.message;
		if (typeof m === 'string') return m;
	} catch {
		/* cai na mensagem genérica */
	}
	return 'O herdr recusou o comando.';
};

export const acoesTotal = Metric.counter('jarvis_controle_acoes_total', {
	description: 'Ações de controle de agentes do herdr pelo app, por ação e agente.',
	incremental: true
});

export const listar = Effect.gen(function* () {
	const cli = yield* HerdrCli;
	return parseAgentes(yield* cli.run(['agent', 'list']));
});

const lerCauda = (pane: string, linhas = CAUDA_LINHAS) =>
	Effect.gen(function* () {
		const cli = yield* HerdrCli;
		return limparTerminal(yield* cli.run(['pane', 'read', pane, '--lines', String(linhas)]));
	});

/** Os agentes vivos com a cauda do terminal e o modo lido do rodapé. Um pane que falha ao ler vem sem cauda. */
export const cartoes: Effect.Effect<AgenteCard[], HerdrErro, HerdrCli> = Effect.gen(function* () {
	const agentes = yield* listar;
	return yield* Effect.forEach(
		agentes,
		(a) =>
			lerCauda(a.pane).pipe(
				Effect.map((cauda): AgenteCard => ({ ...a, cauda, modo: parseModo(cauda) })),
				Effect.catch(() => Effect.succeed<AgenteCard>({ ...a, cauda: '', modo: null }))
			),
		{ concurrency: 4 }
	);
});

const agenteVivo = (pane: string) =>
	listar.pipe(
		Effect.flatMap((vivos) => {
			const alvo = vivos.find((a) => a.pane === pane);
			return alvo
				? Effect.succeed<AgenteVivo>(alvo)
				: Effect.fail(new HerdrErro({ motivo: 'pane', message: 'Esse agente não está mais vivo.' }));
		})
	);

const teclas = (pane: string, lista: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const cli = yield* HerdrCli;
		const fora = lista.find((t) => !TECLAS_PERMITIDAS.has(t));
		if (fora !== undefined) return yield* new HerdrErro({ motivo: 'tecla', message: `Tecla fora da lista: ${fora}` });
		yield* cli.run(['pane', 'send-keys', pane, ...lista]);
	});

/**
 * Executa uma ação num agente vivo. `steer` manda o texto e depois ctrl+enter; as demais mandam
 * a tecla fixa da ação. Cada uma incrementa `jarvis_controle_acoes_total{acao,agente}` e deixa uma linha de log.
 */
export const executar = (pane: string, acao: Acao, entrada?: unknown): Effect.Effect<AgenteVivo, HerdrErro, HerdrCli> =>
	Effect.gen(function* () {
		const alvo = yield* agenteVivo(pane);
		if (acao === 'steer') {
			const valido = validarTexto(entrada);
			if (!valido.ok) return yield* new HerdrErro({ motivo: 'texto', message: valido.motivo });
			// O texto vai como argumento posicional do CLI (que não aceita `--`): um `-` inicial viraria flag.
			if (valido.texto.startsWith('-'))
				return yield* new HerdrErro({ motivo: 'texto', message: 'O texto não pode começar com "-". Comece com uma letra ou outro caractere.' });
			const cli = yield* HerdrCli;
			yield* cli.run(['pane', 'send-text', alvo.pane, valido.texto]);
		}
		yield* teclas(alvo.pane, TECLAS[acao]);
		yield* Effect.logInfo(`controle: ${acao} em ${alvo.nome}`);
		yield* Metric.update(Metric.withAttributes(acoesTotal, { acao, agente: alvo.nome }), 1);
		return alvo;
	}).pipe(
		Effect.tapError((e) => Effect.logWarning(`controle: ${acao} falhou (${e.motivo}): ${e.message}`)),
		Effect.annotateLogs({ acao })
	);
