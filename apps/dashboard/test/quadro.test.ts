import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { criarPedido, lerQuadro, validarPedido } from '../src/lib/server/quadro.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'quadro-'));
const form = (o: Record<string, string>) => {
	const f = new FormData();
	for (const [k, v] of Object.entries(o)) f.set(k, v);
	return f;
};

describe('quadro', () => {
	test('banco inexistente: estado vazio', async () => {
		expect(await lerQuadro({ caminho: join(dir(), 'nao.db') })).toEqual({ existe: false, cards: [], mensagens: [] });
	});

	test('cria cards sequenciais com criado_por fernando e evento', async () => {
		const caminho = join(dir(), 'q.db');
		expect(await criarPedido({ titulo: 'A', brief: 'b', kit: 'k' }, { caminho, agora: 1_800_000_000_000 })).toBe('J-1');
		expect(await criarPedido({ titulo: 'B', brief: '', kit: '' }, { caminho })).toBe('J-2');
		const q = await lerQuadro({ caminho });
		const c = q.cards.find((x) => x.id === 'J-1')!;
		expect(c).toMatchObject({ titulo: 'A', kit: 'k', estado: 'aberto', criadoPor: 'fernando', criadoEm: 1_800_000_000_000 });
		expect(c.eventos[0].tipo).toBe('criado');
		expect(q.cards.find((x) => x.id === 'J-2')!.kit).toBeNull();
	});

	test('lê esquema do pacote: segundos viram ms, mensagens recentes primeiro', async () => {
		const caminho = join(dir(), 'q.db');
		await criarPedido({ titulo: 'A', brief: '', kit: '' }, { caminho });
		const db = new Database(caminho);
		db.run("UPDATE cards SET estado='pego', dono='bot1', lease_ate=1800000000");
		db.run("INSERT INTO mensagens VALUES ('bot1','bot2','oi',100), ('bot2','bot1','tchau',200)");
		db.close();
		const q = await lerQuadro({ caminho });
		expect(q.cards[0]).toMatchObject({ estado: 'pego', dono: 'bot1', leaseAte: 1_800_000_000_000 });
		expect(q.mensagens.map((m) => m.texto)).toEqual(['tchau', 'oi']);
	});

	test('validação', () => {
		expect(validarPedido(form({ titulo: '  ' })).ok).toBe(false);
		expect(validarPedido(form({ titulo: 'x'.repeat(121) })).ok).toBe(false);
		expect(validarPedido(form({ titulo: ' ok ', brief: 'b' }))).toMatchObject({ ok: true, pedido: { titulo: 'ok', brief: 'b', kit: '' } });
	});
});
