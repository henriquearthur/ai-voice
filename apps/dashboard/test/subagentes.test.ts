import { describe, expect, test } from 'bun:test';
import { subagentesExemplo } from '../src/lib/telemetria/exemplo.ts';
import { arvoreSubagentes, contarSubagentes, normalizeEstado } from '../src/lib/telemetria/model.ts';

const now = Date.parse('2026-10-12T12:00:00Z');
const agentes = (a: unknown[]) => normalizeEstado({ herdr: { agentes: a } }, now)!.herdr!.agentes;

describe('subagentes no normalizador', () => {
	test('coletor antigo, sem o campo: lista vazia e marcado como não publicado', () => {
		const [a] = agentes([{ nome: 'maestro', estado: 'working' }]);
		expect(a.subagentes).toEqual([]);
		expect(a.subagentesPublicados).toBe(false);
		expect(a.sessao).toBeNull();
	});

	test('lê sessão e subagentes do exemplo', () => {
		const [a] = agentes([{ nome: 'maestro', sessao: 'abc', subagentes: subagentesExemplo(now) }]);
		expect(a.sessao).toBe('abc');
		expect(a.subagentesPublicados).toBe(true);
		expect(a.subagentes).toHaveLength(5);
		const sa1a = a.subagentes.find((s) => s.id === 'sa-1a')!;
		expect(sa1a).toMatchObject({ paiId: 'sa-1', estado: 'rodando', aguardando: 'aprovação do Bash', tipo: 'general-purpose', fim: null });
		expect(sa1a.inicio).toBe(now - 2 * 60_000);
		expect(a.subagentes.find((s) => s.id === 'sa-3')).toMatchObject({ estado: 'terminou', duracaoS: 480, resumoFim: 'Dois achados, nenhum bloqueante.' });
	});

	test('descarta itens sem id e tolera lixo', () => {
		const [a] = agentes([{ nome: 'x', subagentes: [null, 3, {}, { id: 'ok' }] }]);
		expect(a.subagentes.map((s) => s.id)).toEqual(['ok']);
		expect(a.subagentes[0].estado).toBe('rodando');
	});
});

describe('árvore', () => {
	const subs = agentes([{ nome: 'maestro', subagentes: subagentesExemplo(now) }])[0].subagentes;

	test('raiz: ativos primeiro (rodando antes de parado), concluídos por último', () => {
		const raizes = arvoreSubagentes(subs);
		expect(raizes.map((n) => n.sub.id)).toEqual(['sa-1', 'sa-2', 'sa-3']);
		expect(raizes.map((n) => n.ativo)).toEqual([true, true, false]);
	});

	test('filhos ficam sob quem os abriu', () => {
		const [sa1] = arvoreSubagentes(subs);
		expect(sa1.filhos.map((n) => n.sub.id)).toEqual(['sa-1a', 'sa-1b']);
		expect(sa1.filhos[0].sub.abertoPor).toBe('Mapear as telas de agentes do dashboard');
	});

	test('pai concluído com filho rodando continua ativo', () => {
		const t = agentes([
			{
				nome: 'x',
				subagentes: [
					{ id: 'p', estado: 'terminou', fim: now },
					{ id: 'f', pai_id: 'p', estado: 'rodando' }
				]
			}
		])[0].subagentes;
		expect(arvoreSubagentes(t)[0].ativo).toBe(true);
	});

	test('pai desconhecido vai para a raiz e ciclos não somem', () => {
		const t = agentes([
			{
				nome: 'x',
				subagentes: [
					{ id: 'orfao', pai_id: 'sumiu' },
					{ id: 'a', pai_id: 'b' },
					{ id: 'b', pai_id: 'a' }
				]
			}
		])[0].subagentes;
		expect(arvoreSubagentes(t).map((n) => n.sub.id).sort()).toEqual(['a', 'b', 'orfao']);
	});

	test('contador do cabeçalho', () => {
		expect(contarSubagentes(subs)).toEqual({ rodando: 2, parados: 1, concluidos: 2, total: 5 });
	});
});
