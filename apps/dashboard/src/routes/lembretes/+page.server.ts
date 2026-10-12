import { Reminders } from '@jarvis/apple';
import { fail } from '@sveltejs/kit';
import { Effect } from 'effect';
import type { AppleFailure } from '#lib/apple/failure.js';
import { runApple } from '#lib/server/apple-gateway.js';
import { NOTES_MAX, TITLE_MAX, parseReminderForm } from '#lib/server/reminder-form.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => {
	const requested = url.searchParams.get('lista')?.trim() || null;
	const includeCompleted = url.searchParams.get('concluidos') === '1';

	const board = runApple(
		Reminders.use((reminders) =>
			Effect.gen(function* () {
				const lists = yield* reminders.lists;
				// An unknown name (renamed or deleted list, edited URL) falls back to every list instead of failing.
				const list = requested !== null && lists.includes(requested) ? requested : null;
				const items = yield* reminders.list({ ...(list === null ? {} : { list }), includeCompleted });
				return { lists, list, items };
			})
		)
	);

	// Streamed: the page shows up at once, while macOS may still be asking for Automation consent.
	return { board, filter: { list: requested, includeCompleted }, limits: { title: TITLE_MAX, notes: NOTES_MAX } };
};

const status: Record<AppleFailure['kind'], number> = {
	permission: 403,
	timeout: 504,
	automation: 422,
	unexpected: 500
};

export const actions = {
	add: async ({ request }) => {
		const form = parseReminderForm(await request.formData());
		if (!form.ok) return fail(400, { values: form.values, errors: form.errors });

		const outcome = await runApple(Reminders.use((reminders) => reminders.add(form.input)));
		if (!outcome.ok) return fail(status[outcome.failure.kind], { values: form.values, failure: outcome.failure });

		return { added: { reminder: outcome.value, at: Date.now() } };
	}
} satisfies Actions;
