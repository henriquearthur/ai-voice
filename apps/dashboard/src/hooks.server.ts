import type { Handle } from '@sveltejs/kit/hooks';
import { redirect } from '@sveltejs/kit';
import { isConfigured } from '#lib/server/onboarding/config.js';
import { isLocalRequest } from '#lib/server/onboarding/loopback.js';
import { paths as onboardingPaths } from '#lib/server/onboarding/runtime.js';
import { recordOperation } from '@jarvis/telemetry';
import { alexaRuntime } from '#lib/server/alexa-runtime.js';

// adapter-node emits this once every connection has closed, so in-flight requests finish first.
process.once('sveltekit:shutdown', () => alexaRuntime.dispose());

/**
 * Every request lands in `jarvis_operacao_ms` as `dashboard.requisicao`, labelled with the route id
 * (never the URL) and the method, so the Telemetria panel shows the dashboard's latency and errors.
 */
export const handle: Handle = async ({ event, resolve }) => {
	const start = performance.now();
	let status = 500;
	// Primeira execução neste Mac (sem ~/.config/jarvis/config.json nem instalação anterior): a página inicial
	// vira o onboarding. Só para quem abre no próprio Mac; da LAN o dashboard segue como está.
	if (
		event.url.pathname === '/' &&
		event.request.method === 'GET' &&
		isLocalRequest(event.getClientAddress(), event.request.headers) &&
		!isConfigured(onboardingPaths)
	) {
		redirect(307, '/onboarding');
	}
	try {
		const response = await resolve(event);
		status = response.status;
		return response;
	} finally {
		const rota = event.route.id ?? 'sem-rota';
		alexaRuntime.runFork(
			recordOperation('dashboard.requisicao', performance.now() - start, status >= 500 ? 'erro' : 'ok', {
				servidor: 'dashboard',
				rota,
				metodo: event.request.method,
				status: String(status)
			})
		);
	}
};
