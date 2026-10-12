import { lerLote, registrarLote } from '../../../lib/server/telemetria-web.js';
import { LIMITES } from '../../../lib/telemetria/web/lote.js';
import type { RequestHandler } from './$types';

/** Reads at most `limite` bytes of the body; null when it is longer. */
async function corpoLimitado(request: Request, limite: number): Promise<string | null> {
	const declarado = Number(request.headers.get('content-length') ?? '0');
	if (declarado > limite) return null;
	if (!request.body) return '';
	const reader = request.body.getReader();
	const partes: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limite) {
			await reader.cancel().catch(() => {});
			return null;
		}
		partes.push(value);
	}
	const tudo = new Uint8Array(total);
	let at = 0;
	for (const p of partes) {
		tudo.set(p, at);
		at += p.byteLength;
	}
	return new TextDecoder().decode(tudo);
}

/**
 * The frontend's telemetry batch (see `#lib/telemetria/web/coleta.ts`): every 15 s and once more with
 * `sendBeacon` when the page goes away. Answers 204 when recorded, 413 when too large, 400 when not a batch.
 */
export const POST: RequestHandler = async ({ request }) => {
	const texto = await corpoLimitado(request, LIMITES.bytes);
	if (texto === null) return new Response(null, { status: 413 });
	let raw: unknown;
	try {
		raw = JSON.parse(texto);
	} catch {
		return new Response(null, { status: 400 });
	}
	const lote = lerLote(raw);
	if (!lote) return new Response(null, { status: 400 });
	await registrarLote(lote);
	return new Response(null, { status: 204 });
};
