import { fail } from '@sveltejs/kit';
import { Effect } from 'effect';
import { isAcao } from '#lib/agentes/model.js';
import { agentesRuntime } from '#lib/server/agentes-runtime.js';
import { cartoes, executar } from '#lib/server/herdr-controle.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ depends }) => {
	depends('app:agentes');
	const lido = await agentesRuntime.runPromise(
		cartoes.pipe(
			Effect.map((agentes) => ({ ok: true as const, agentes })),
			Effect.catch((e) => Effect.succeed({ ok: false as const, erro: e.message }))
		)
	);
	return { ...lido, geradoEm: Date.now() };
};

/** Um único POST: o pane vem escondido no formulário e é conferido contra os agentes vivos no servidor. */
export const actions = {
	acao: async ({ request }) => {
		const dados = await request.formData();
		const pane = dados.get('pane');
		const acao = dados.get('acao');
		if (typeof pane !== 'string' || !isAcao(acao)) return fail(400, { erro: 'Pedido inválido.' });

		const resultado = await agentesRuntime.runPromise(
			executar(pane, acao, dados.get('texto')).pipe(
				Effect.map((a) => ({ ok: true as const, nome: a.nome })),
				Effect.catch((e) => Effect.succeed({ ok: false as const, erro: e.message, motivo: e.motivo }))
			)
		);
		if (!resultado.ok) return fail(resultado.motivo === 'pane' ? 404 : resultado.motivo === 'cli' ? 502 : 400, { pane, acao, erro: resultado.erro });
		return { pane, acao, enviado: resultado.nome, em: Date.now() };
	}
} satisfies Actions;
