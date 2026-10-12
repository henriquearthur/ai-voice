import { fail } from '@sveltejs/kit';
import { type Control, control, readSnapshot } from '#lib/server/escuta.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => ({ snapshot: await readSnapshot() });

const run = (action: Control) => async () => {
	const result = await control(action);
	return result.ok ? { control: { action, message: result.message, at: Date.now() } } : fail(409, { control: { action, message: result.message, at: Date.now(), failed: true } });
};

export const actions = {
	pausar: run('pausar'),
	retomar: run('retomar'),
	reiniciar: run('reiniciar')
} satisfies Actions;
