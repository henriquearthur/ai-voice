import { readPainel } from '#lib/server/telemetria.js';
import { readAppWeb } from '#lib/server/telemetria-app.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const [painel, app] = await Promise.all([readPainel(), readAppWeb()]);
	return { painel, app };
};
