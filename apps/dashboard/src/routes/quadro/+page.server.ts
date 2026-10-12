import { fail } from '@sveltejs/kit';
import { criarPedido, lerQuadro, validarPedido } from '#lib/server/quadro.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ depends }) => {
	depends('app:quadro');
	return { ...(await lerQuadro()), geradoEm: Date.now() };
};

/** O POST passa pela checagem de origem (CSRF) do SvelteKit, como as ações da /agentes. */
export const actions = {
	criar: async ({ request }) => {
		const v = validarPedido(await request.formData());
		if (!v.ok) return fail(400, { erro: v.erro });
		try {
			return { criado: await criarPedido(v.pedido) };
		} catch {
			return fail(500, { erro: 'Não consegui gravar no quadro.' });
		}
	}
} satisfies Actions;
