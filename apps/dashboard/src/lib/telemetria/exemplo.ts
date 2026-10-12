/**
 * Sample subagents in the collector's shape (`herdr.agentes[].subagentes`), relative to `now`.
 * Used by the tests and by the Telemetria tab's preview while the collector does not publish the field yet.
 */
export function subagentesExemplo(now: number) {
	const iso = (msAtras: number) => new Date(now - msAtras).toISOString();
	const min = 60_000;
	return [
		{
			id: 'sa-1',
			pai_id: null,
			aberto_por: 'maestro',
			descricao: 'Mapear as telas de agentes do dashboard',
			tipo: 'Explore',
			estado: 'rodando',
			inicio: iso(6 * min),
			fim: null,
			duracao_s: 360,
			ultima_atividade_em: iso(8_000),
			aguardando: null,
			resumo_fim: null
		},
		{
			id: 'sa-1a',
			pai_id: 'sa-1',
			aberto_por: 'Mapear as telas de agentes do dashboard',
			descricao: 'Ler o normalizador do coletor',
			tipo: 'general-purpose',
			estado: 'rodando',
			inicio: iso(2 * min),
			fim: null,
			duracao_s: 120,
			ultima_atividade_em: iso(40_000),
			aguardando: 'aprovação do Bash',
			resumo_fim: null
		},
		{
			id: 'sa-1b',
			pai_id: 'sa-1',
			aberto_por: 'Mapear as telas de agentes do dashboard',
			descricao: 'Procurar outras listas de agentes',
			tipo: 'Explore',
			estado: 'terminou',
			inicio: iso(5 * min),
			fim: iso(3 * min),
			duracao_s: 118,
			ultima_atividade_em: iso(3 * min),
			aguardando: null,
			resumo_fim: 'Só a aba Telemetria lista agentes.'
		},
		{
			id: 'sa-2',
			pai_id: null,
			aberto_por: 'maestro',
			descricao: 'Rodar a suíte do coletor',
			tipo: 'general-purpose',
			estado: 'parado',
			inicio: iso(12 * min),
			fim: null,
			duracao_s: 720,
			ultima_atividade_em: iso(9 * min),
			aguardando: 'resposta do herdr',
			resumo_fim: null
		},
		{
			id: 'sa-3',
			pai_id: null,
			aberto_por: 'maestro',
			descricao: 'Revisar o diff do escuta',
			tipo: 'code-review',
			estado: 'terminou',
			inicio: iso(30 * min),
			fim: iso(22 * min),
			duracao_s: 480,
			ultima_atividade_em: iso(22 * min),
			aguardando: null,
			resumo_fim: 'Dois achados, nenhum bloqueante.'
		}
	];
}
