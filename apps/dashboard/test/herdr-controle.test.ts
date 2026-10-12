import { describe, expect, test } from 'bun:test';
import { Effect, Layer } from 'effect';
import { parseAgentes, parseModo, validarTexto, TECLAS, TECLAS_PERMITIDAS } from '../src/lib/agentes/model.ts';
import { HerdrCli, HerdrErro, cartoes, executar } from '../src/lib/server/herdr-controle.ts';

const lista = JSON.stringify({
	result: {
		agents: [
			{ agent: 'claude', agent_status: 'blocked', name: 'maestro', pane_id: 'w:p1', cwd: '/x', terminal_title_stripped: 'Tarefa' },
			{ agent: 'claude', agent_status: 'working', name: 'outro', pane_id: 'w:p2' },
			{ agent: 'claude', agent_status: 'estranho', pane_id: 'w:p3' }
		]
	}
});

/** Um herdr de mentira: grava cada chamada e responde `agent list` e `pane read` com o que o teste pedir. */
const mock = (opcoes: { cauda?: string; falhaEm?: string } = {}) => {
	const chamadas: string[][] = [];
	const layer = Layer.succeed(
		HerdrCli,
		HerdrCli.of({
			run: (args) => {
				chamadas.push([...args]);
				if (args[0] === 'agent' && args[1] === 'list') return Effect.succeed(lista);
				if (opcoes.falhaEm === args[1]) return Effect.fail(new HerdrErro({ motivo: 'cli', message: 'falhou' }));
				if (args[1] === 'read') return Effect.succeed(opcoes.cauda ?? '');
				return Effect.succeed('{"result":{}}');
			}
		})
	);
	return { chamadas, run: <A, E>(e: Effect.Effect<A, E, HerdrCli>) => Effect.runPromise(e.pipe(Effect.provide(layer))) };
};

describe('parseAgentes', () => {
	test('lê nome, pane, estado e bloqueio', () => {
		const a = parseAgentes(lista);
		expect(a.map((x) => [x.nome, x.pane, x.estado, x.bloqueado])).toEqual([
			['maestro', 'w:p1', 'blocked', true],
			['outro', 'w:p2', 'working', false],
			['w:p3', 'w:p3', 'unknown', false]
		]);
		expect(a[0]!.titulo).toBe('Tarefa');
	});
	test('entrada quebrada vira lista vazia', () => {
		expect(parseAgentes('não é json')).toEqual([]);
		expect(parseAgentes('{"error":{"code":"x"}}')).toEqual([]);
	});
});

describe('parseModo', () => {
	test.each([
		['  ⏵⏵ accept edits on · 5 shells', 'aceitar-edicoes'],
		['  ⏸ plan mode on (shift+tab to cycle)', 'plano'],
		['  ⏵⏵ auto mode on (shift+tab to cycle)', 'auto'],
		['  ⏵⏵ bypass permissions on (shift+tab to cycle)', 'sem-permissao'],
		['  ? for shortcuts', 'padrao']
	])('%s', (rodape, modo) => {
		expect(parseModo(`saída qualquer\n──────\n❯\n${rodape}\n\n`)).toBe(modo as never);
	});
	test('sem rodapé reconhecível não há modo', () => {
		expect(parseModo('$ ls\narquivo\n')).toBeNull();
	});
	test('menção antiga no meio da saída não vale', () => {
		const corpo = 'accept edits on\n' + 'linha\n'.repeat(20);
		expect(parseModo(corpo)).toBeNull();
	});
});

describe('validarTexto', () => {
	test('recusa vazio, longo e controle', () => {
		expect(validarTexto('   ').ok).toBe(false);
		expect(validarTexto('a'.repeat(2001)).ok).toBe(false);
		expect(validarTexto('oi\u001b[31m').ok).toBe(false);
		expect(validarTexto(42).ok).toBe(false);
	});
	test('aceita texto com quebra de linha', () => {
		expect(validarTexto('  linha 1\nlinha 2 ')).toEqual({ ok: true, texto: 'linha 1\nlinha 2' });
	});
});

describe('lista branca de teclas', () => {
	test('só as cinco teclas fixas', () => {
		expect([...TECLAS_PERMITIDAS].sort()).toEqual(['ctrl+c', 'ctrl+enter', 'enter', 'esc', 'shift+tab']);
		expect(TECLAS.aprovar).toEqual(['enter']);
		expect(TECLAS.negar).toEqual(['esc']);
	});
});

describe('executar', () => {
	test('aprovar manda enter ao pane certo, sem shell nem texto', async () => {
		const h = mock();
		await h.run(executar('w:p1', 'aprovar'));
		expect(h.chamadas).toEqual([['agent', 'list'], ['pane', 'send-keys', 'w:p1', 'enter']]);
	});
	test.each([
		['negar', 'esc'],
		['modo', 'shift+tab'],
		['interromper', 'ctrl+c']
	] as const)('%s manda %s', async (acao, tecla) => {
		const h = mock();
		await h.run(executar('w:p2', acao));
		expect(h.chamadas.at(-1)).toEqual(['pane', 'send-keys', 'w:p2', tecla]);
	});
	test('steer manda o texto e ctrl+enter', async () => {
		const h = mock();
		await h.run(executar('w:p1', 'steer', '  texto normal; a-b '));
		expect(h.chamadas.slice(1)).toEqual([
			['pane', 'send-text', 'w:p1', 'texto normal; a-b'],
			['pane', 'send-keys', 'w:p1', 'ctrl+enter']
		]);
	});
	test.each(['--help', '-x', '  --help; rm -rf /', '-'])('steer rejeita texto que começa com "-": %s', async (texto) => {
		const h = mock();
		const erro = await h.run(executar('w:p1', 'steer', texto).pipe(Effect.flip));
		expect(erro.motivo).toBe('texto');
		expect(erro.message).toContain('não pode começar com "-"');
		expect(h.chamadas).toEqual([['agent', 'list']]);
	});
	test('pane que não é agente vivo é recusado sem escrever nada', async () => {
		const h = mock();
		const erro = await h.run(executar('w:p9', 'aprovar').pipe(Effect.flip));
		expect(erro.motivo).toBe('pane');
		expect(h.chamadas).toEqual([['agent', 'list']]);
	});
	test('pane com cara de opção também é recusado', async () => {
		const h = mock();
		const erro = await h.run(executar('--help', 'aprovar').pipe(Effect.flip));
		expect(erro.motivo).toBe('pane');
		expect(h.chamadas.every((c) => c[0] === 'agent')).toBe(true);
	});
	test('steer com texto inválido não manda nada', async () => {
		const h = mock();
		const erro = await h.run(executar('w:p1', 'steer', '  ').pipe(Effect.flip));
		expect(erro.motivo).toBe('texto');
		expect(h.chamadas).toEqual([['agent', 'list']]);
	});
	test('falha do CLI no envio sobe como erro', async () => {
		const h = mock({ falhaEm: 'send-keys' });
		const erro = await h.run(executar('w:p1', 'aprovar').pipe(Effect.flip));
		expect(erro.motivo).toBe('cli');
	});
});

describe('cartoes', () => {
	test('junta cauda e modo; pane ilegível vem sem cauda', async () => {
		const h = mock({ cauda: 'oi\n  ⏵⏵ auto mode on (shift+tab to cycle)\n' });
		const c = await h.run(cartoes);
		expect(c).toHaveLength(3);
		expect(c[0]).toMatchObject({ nome: 'maestro', bloqueado: true, modo: 'auto' });
		expect(h.chamadas.filter((x) => x[1] === 'read')[0]).toEqual(['pane', 'read', 'w:p1', '--lines', '40']);
		const f = mock({ falhaEm: 'read' });
		expect((await f.run(cartoes))[0]).toMatchObject({ cauda: '', modo: null });
	});
});
