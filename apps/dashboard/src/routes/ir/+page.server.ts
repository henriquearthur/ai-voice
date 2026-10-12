import { Maps, Phone } from '@jarvis/apple';
import { fail } from '@sveltejs/kit';
import type { AppleFailure } from '#lib/apple/failure.js';
import { isMapsMode, type MapsMode } from '#lib/ir/maps.js';
import { checkPhone, isCallVia } from '#lib/ir/phone.js';
import { runApple } from '#lib/server/apple-gateway.js';
import type { Actions } from './$types';

const field = (data: FormData, name: string) => {
	const value = data.get(name);
	return typeof value === 'string' ? value.trim() : '';
};

const failed = (failure: AppleFailure) => (failure.kind === 'permission' ? 403 : 424);

// Nothing here runs a Maps or Phone effect until the form validates; the call additionally needs the explicit confirm flag.
export const actions = {
	search: async ({ request }) => {
		const data = await request.formData();
		const query = field(data, 'query');
		const values = { panel: 'maps' as const, kind: 'search' as const, query };
		if (query === '') return fail(400, { ...values, invalid: 'Escreva o lugar que o Mapas deve buscar.' });
		if (query.length > 500) return fail(400, { ...values, invalid: 'A busca passa de 500 caracteres.' });

		const outcome = await runApple(Maps.use((maps) => maps.search({ query })));
		if (!outcome.ok) return fail(failed(outcome.failure), { ...values, failure: outcome.failure });
		return { ...values, opened: { url: outcome.value.url, at: Date.now() } };
	},

	directions: async ({ request }) => {
		const data = await request.formData();
		const to = field(data, 'to');
		const from = field(data, 'from');
		const rawMode = field(data, 'mode');
		const mode: MapsMode = isMapsMode(rawMode) ? rawMode : 'driving';
		const values = { panel: 'maps' as const, kind: 'directions' as const, to, from, mode };
		if (to === '') return fail(400, { ...values, invalid: 'Informe o destino da rota.' });
		if (to.length > 500 || from.length > 500) return fail(400, { ...values, invalid: 'Endereço com mais de 500 caracteres.' });

		const outcome = await runApple(Maps.use((maps) => maps.directions({ to, mode, ...(from === '' ? {} : { from }) })));
		if (!outcome.ok) return fail(failed(outcome.failure), { ...values, failure: outcome.failure });
		return { ...values, opened: { url: outcome.value.url, at: Date.now() } };
	},

	// No-JS counterpart of the in-page confirmation: validates and asks the page to show the confirm step.
	review: async ({ request }) => {
		const data = await request.formData();
		const number = field(data, 'number');
		const via = field(data, 'via');
		const check = checkPhone(number);
		const values = { panel: 'phone' as const, number, via: isCallVia(via) ? via : ('phone' as const) };
		if (!check.ok) return fail(400, { ...values, invalid: check.hint });
		return { ...values, review: true as const };
	},

	call: async ({ request }) => {
		const data = await request.formData();
		const number = field(data, 'number');
		const via = field(data, 'via');
		const values = { panel: 'phone' as const, number, via: isCallVia(via) ? via : ('phone' as const) };

		const check = checkPhone(number);
		if (!check.ok) return fail(400, { ...values, invalid: check.hint });
		if (data.get('confirmed') !== 'yes') {
			return fail(400, { ...values, invalid: 'A ligação precisa de confirmação explícita.' });
		}

		const outcome = await runApple(Phone.use((phone) => phone.call({ number: check.e164, via: values.via })));
		if (!outcome.ok) return fail(failed(outcome.failure), { ...values, failure: outcome.failure });
		return { ...values, placed: { display: check.display, at: Date.now() } };
	}
} satisfies Actions;
