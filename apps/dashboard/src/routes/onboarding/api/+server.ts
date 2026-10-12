import { error, json } from '@sveltejs/kit';
import { normalizeConfig, SECRET_IDS, type SecretId } from '#lib/onboarding/model.js';
import { saveConfig } from '#lib/server/onboarding/config.js';
import { isLocalRequest } from '#lib/server/onboarding/loopback.js';
import { jobs, onboardingState, paths, startTask, TASKS } from '#lib/server/onboarding/runtime.js';
import { saveSecret } from '#lib/server/onboarding/secrets.js';
import type { RequestHandler } from './$types';

/**
 * Estado do onboarding (GET) e as ações (POST). Só atende este Mac: instalar, gravar config e mexer no
 * Keychain a partir da LAN ou da tailnet seria entregar a máquina a quem alcança a porta.
 */
function guard(address: string, request: Request) {
	if (!isLocalRequest(address, request.headers)) error(403, 'O onboarding só pode ser usado neste Mac.');
}

export const GET: RequestHandler = ({ getClientAddress, request }) => {
	guard(getClientAddress(), request);
	return json(onboardingState(), { headers: { 'cache-control': 'no-store' } });
};

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	guard(getClientAddress(), request);
	// JSON obriga o navegador a fazer preflight (que este servidor não libera) num POST vindo de outro site;
	// e uma Origin, se vier, tem de ser a própria página.
	const origin = request.headers.get('origin');
	if (!request.headers.get('content-type')?.startsWith('application/json')) error(415, 'esperava JSON');
	if (origin && new URL(origin).host !== request.headers.get('host')) error(403, 'origem não permitida');
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body.tipo !== 'string') error(400, 'pedido sem tipo');

	switch (body.tipo) {
		case 'instalar': {
			const item = String(body.item ?? '');
			if (!(item in TASKS)) error(400, `item desconhecido: ${item}`);
			return json({ job: startTask(item) });
		}
		case 'cancelar':
			jobs.cancel(String(body.item ?? ''));
			return json({ ok: true });
		case 'config':
		case 'concluir': {
			const cfg = normalizeConfig(body.config);
			const final = body.tipo === 'concluir' ? { ...cfg, concluidoEm: new Date().toISOString() } : cfg;
			// "config" nunca desfaz um onboarding já concluído: refazer pelas Configurações mantém a marca.
			saveConfig(paths, final);
			return json({ config: final });
		}
		case 'segredo': {
			const id = String(body.id ?? '') as SecretId;
			if (!SECRET_IDS.includes(id)) error(400, 'segredo desconhecido');
			try {
				saveSecret(id, String(body.valor ?? ''));
			} catch (e) {
				error(400, e instanceof Error ? e.message : 'não deu para salvar');
			}
			// O valor nunca volta: só a confirmação de que existe.
			return json({ id, salvo: true });
		}
		default:
			error(400, `tipo desconhecido: ${body.tipo}`);
	}
};
