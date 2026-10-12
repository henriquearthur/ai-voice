import { beforeAll, describe, expect, test } from 'bun:test';
import { Agregador, LIMITES, tipoDeErro } from '../src/lib/telemetria/web/lote.ts';
import { origemDe } from '../src/lib/telemetria/web/coleta.ts';

// No OTLP export from the tests: the registry still records, and is read back below.
process.env.JARVIS_TELEMETRY = '0';
type Server = typeof import('../src/lib/server/telemetria-web.ts');
type Rota = typeof import('../src/routes/telemetria/cliente/+server.ts');
let server: Server;
let rota: Rota;

beforeAll(async () => {
	server = await import('../src/lib/server/telemetria-web.ts');
	rota = await import('../src/routes/telemetria/cliente/+server.ts');
	server.configurarAtrasoSerieNova(0);
});

describe('agregador do cliente', () => {
	test('vazio não gera lote', () => {
		expect(new Agregador('browser').fechar()).toBeNull();
	});

	test('soma erros, reconexões e descartes por rótulo e recomeça depois de fechar', () => {
		const a = new Agregador('desktop');
		a.vital('LCP', '/telemetria', 812.4);
		a.vital('INP', '/telemetria', Number.NaN);
		a.navegacao('/agenda', 120.6);
		a.erro('TypeError', '/agenda');
		a.erro('TypeError', '/agenda');
		a.erro('rejeicao/Error', '/');
		a.reconexao('/telemetria/ao-vivo');
		a.reconexao('/telemetria/ao-vivo');
		a.descarte('/telemetria/ao-vivo', 'coalescido');
		a.descarte('/telemetria/ao-vivo', 'repetido');
		a.descarte('/telemetria/ao-vivo', 'coalescido');
		a.atraso('/telemetria/ao-vivo', 12.2);
		a.tempo('visivel', 10_000);
		a.tempo('oculto', 5_000);
		a.tempo('visivel', 4_000);

		const lote = a.fechar(52_428_800)!;
		expect(lote).toEqual({
			v: 1,
			origem: 'desktop',
			vitais: [{ m: 'LCP', rota: '/telemetria', v: 812.4 }],
			navegacoes: [{ rota: '/agenda', ms: 121 }],
			erros: [
				{ tipo: 'TypeError', rota: '/agenda', n: 2 },
				{ tipo: 'rejeicao/Error', rota: '/', n: 1 }
			],
			reconexoes: [{ fluxo: '/telemetria/ao-vivo', n: 2 }],
			atrasos: [{ fluxo: '/telemetria/ao-vivo', ms: 12 }],
			descartes: [
				{ fluxo: '/telemetria/ao-vivo', motivo: 'coalescido', n: 2 },
				{ fluxo: '/telemetria/ao-vivo', motivo: 'repetido', n: 1 }
			],
			heap: 52_428_800,
			tempo: { visivelMs: 14_000, ocultoMs: 5_000 }
		});
		expect(a.fechar()).toBeNull();
	});

	test('só tempo é marcado como tal, e as listas têm teto', () => {
		const a = new Agregador('browser');
		a.tempo('oculto', 1000);
		expect(a.soTempo).toBe(true);
		for (let i = 0; i < LIMITES.itens + 50; i++) a.navegacao('/', i);
		expect(a.soTempo).toBe(false);
		expect(a.fechar()!.navegacoes).toHaveLength(LIMITES.itens);
	});

	test('tipo do erro é o nome do construtor, nunca a mensagem', () => {
		expect(tipoDeErro(new TypeError('senha do Fernando'))).toBe('TypeError');
		expect(tipoDeErro({ name: 'texto com espaço' })).toBe('Error');
		expect(tipoDeErro('uma string qualquer', 'rejeicao/')).toBe('rejeicao/string');
		expect(tipoDeErro(undefined, 'rejeicao/')).toBe('rejeicao/undefined');
	});

	test('origem: o Jarvis.app se anuncia no user agent ou por flag', () => {
		const safari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
		expect(origemDe(`${safari} JarvisDesktop/1.0`)).toBe('desktop');
		expect(origemDe(safari)).toBe('browser');
		expect(origemDe(safari, true)).toBe('desktop');
	});
});

describe('validação no servidor', () => {
	test('recusa o que não é lote', () => {
		expect(server.lerLote(null)).toBeNull();
		expect(server.lerLote({ v: 2, origem: 'browser' })).toBeNull();
		expect(server.lerLote({ v: 1, origem: 'android' })).toBeNull();
	});

	test('limpa rótulos, corta números e ignora itens inválidos', () => {
		const lote = server.lerLote({
			v: 1,
			origem: 'browser',
			vitais: [
				{ m: 'LCP', rota: '/agenda', v: 1e12 },
				{ m: 'FID', rota: '/', v: 10 },
				{ m: 'CLS', rota: 'https://evil.example/?q=texto do usuário', v: 0.12 }
			],
			erros: [
				{ tipo: 'Cannot read properties of undefined', rota: '/', n: 3 },
				{ tipo: 'TypeError', rota: '/', n: -1 }
			],
			descartes: [{ fluxo: '/telemetria/ao-vivo', motivo: 'outro', n: 1 }],
			heap: 'muito',
			tempo: { visivelMs: 15_000, ocultoMs: -3 },
			extra: 'ignorado'
		})!;
		expect(lote.vitais).toEqual([
			{ m: 'LCP', rota: '/agenda', v: 600_000 },
			{ m: 'CLS', rota: 'outra', v: 0.12 }
		]);
		expect(lote.erros).toEqual([{ tipo: 'outro', rota: '/', n: 3 }]);
		expect(lote.descartes).toEqual([]);
		expect(lote.heap).toBeNull();
		expect(lote.tempo).toEqual({ visivelMs: 15_000, ocultoMs: 0 });
	});

	test('cada lote vira as métricas jarvis_web_* com os rótulos certos', () => {
		const lote = server.lerLote({
			v: 1,
			origem: 'desktop',
			vitais: [
				{ m: 'INP', rota: '/', v: 96 },
				{ m: 'CLS', rota: '/', v: 0.02 }
			],
			navegacoes: [{ rota: '/agenda', ms: 80 }],
			reconexoes: [{ fluxo: '/conversa/ao-vivo', n: 1 }],
			heap: 1000,
			tempo: { visivelMs: 2000 }
		})!;
		const nomes = server.atualizacoes(lote).map((u) => [(u.metrica as unknown as { id: string }).id, u.labels, u.valor]);
		expect(nomes).toEqual([
			['jarvis_web_lotes_total', { origem: 'desktop' }, 1],
			['jarvis_web_vital_ms', { metrica: 'INP', rota: '/', origem: 'desktop' }, 96],
			['jarvis_web_cls', { rota: '/', origem: 'desktop' }, 0.02],
			['jarvis_web_navegacao_ms', { rota: '/agenda', origem: 'desktop' }, 80],
			['jarvis_web_sse_reconexoes_total', { fluxo: '/conversa/ao-vivo', origem: 'desktop' }, 1],
			['jarvis_web_heap_bytes', { origem: 'desktop' }, 1000],
			['jarvis_web_tempo_segundos_total', { estado: 'visivel', origem: 'desktop' }, 2]
		]);
	});
});

const post = (body: string, headers: Record<string, string> = {}) =>
	rota.POST({ request: new Request('http://127.0.0.1/telemetria/cliente', { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } }) } as never) as Promise<Response>;

async function valor(id: string, labels: Record<string, string>) {
	const snap = await server.lerMetricas();
	const s = snap.find((m) => m.id === id && Object.entries(labels).every(([k, v]) => (m.attributes as Record<string, unknown> | undefined)?.[k] === v));
	return s?.state as Record<string, unknown> | undefined;
}

describe('POST /telemetria/cliente', () => {
	test('204 e as métricas registradas', async () => {
		const res = await post(
			JSON.stringify({
				v: 1,
				origem: 'browser',
				vitais: [{ m: 'LCP', rota: '/telemetria', v: 640 }],
				erros: [{ tipo: 'TypeError', rota: '/telemetria', n: 2 }],
				reconexoes: [{ fluxo: '/telemetria/ao-vivo', n: 3 }],
				heap: 2048,
				tempo: { visivelMs: 15_000, ocultoMs: 0 }
			})
		);
		expect(res.status).toBe(204);
		expect(await valor('jarvis_web_erros_total', { tipo: 'TypeError', rota: '/telemetria', origem: 'browser' })).toMatchObject({ count: 2 });
		expect(await valor('jarvis_web_sse_reconexoes_total', { fluxo: '/telemetria/ao-vivo', origem: 'browser' })).toMatchObject({ count: 3 });
		expect(await valor('jarvis_web_vital_ms', { metrica: 'LCP', rota: '/telemetria', origem: 'browser' })).toMatchObject({ count: 1, sum: 640 });
		expect(await valor('jarvis_web_heap_bytes', { origem: 'browser' })).toMatchObject({ value: 2048 });

		// A second batch adds to the same series.
		await post(JSON.stringify({ v: 1, origem: 'browser', erros: [{ tipo: 'TypeError', rota: '/telemetria', n: 1 }] }));
		expect(await valor('jarvis_web_erros_total', { tipo: 'TypeError', rota: '/telemetria', origem: 'browser' })).toMatchObject({ count: 3 });
	});

	test('400 para JSON quebrado ou fora do formato', async () => {
		expect((await post('{nope')).status).toBe(400);
		expect((await post(JSON.stringify({ v: 1, origem: 'tv' }))).status).toBe(400);
	});

	test('413 acima do limite, pelo cabeçalho ou pelo corpo', async () => {
		const grande = JSON.stringify({ v: 1, origem: 'browser', lixo: 'x'.repeat(LIMITES.bytes) });
		expect((await post(grande)).status).toBe(413);
		expect((await post('{}', { 'content-length': String(LIMITES.bytes + 1) })).status).toBe(413);
	});
});
