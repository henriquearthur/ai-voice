import { describe, expect, test } from 'bun:test';
import { normalizeEstado, saudePeriodico } from '../src/lib/telemetria/model.ts';

const now = Date.parse('2026-10-12T12:00:00Z');
const servico = (o: Record<string, unknown>) => normalizeEstado({ servicos: [o] }, now)!.servicos[0]!;

const maestro = {
	label: 'dev.jarvis.maestro',
	carregado: true,
	vivo: false,
	pid: null,
	periodico: true,
	intervalo_s: 60,
	reinicios: null,
	execucoes: 14,
	ultima_execucao_em: new Date(now - 30_000).toISOString(),
	ultima_saida: '0'
};

describe('serviço periódico', () => {
	test('lê os campos do coletor e não conta execuções como reinícios', () => {
		expect(servico(maestro)).toMatchObject({
			nome: 'maestro',
			periodico: true,
			intervaloS: 60,
			reinicios: null,
			execucoes: 14,
			ultimaExecucao: now - 30_000,
			ultimaSaida: '0'
		});
	});

	test('sem processo e saída 0 está agendado, não parado', () => {
		expect(saudePeriodico(servico(maestro), now)).toBe('agendado');
		expect(saudePeriodico(servico({ ...maestro, vivo: true, pid: 42 }), now)).toBe('rodando');
	});

	test('falha com saída diferente de 0 ou última execução mais velha que 3 intervalos', () => {
		expect(saudePeriodico(servico({ ...maestro, ultima_saida: '1' }), now)).toBe('falhou');
		expect(saudePeriodico(servico({ ...maestro, ultima_saida: '-9' }), now)).toBe('falhou');
		expect(saudePeriodico(servico({ ...maestro, ultima_execucao_em: new Date(now - 181_000).toISOString() }), now)).toBe('atrasado');
		expect(saudePeriodico(servico({ ...maestro, ultima_execucao_em: null }), now)).toBe('agendado');
	});

	test('serviço comum continua contando reinícios', () => {
		expect(servico({ label: 'dev.jarvis.tts', vivo: true, pid: 1, reinicios: 7, execucoes: 8 })).toMatchObject({
			periodico: false,
			reinicios: 7
		});
		expect(servico({ label: 'dev.jarvis.tts', vivo: true, pid: 1, runs: 8 }).reinicios).toBe(8);
	});
});
