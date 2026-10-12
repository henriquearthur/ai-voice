import { Calendar } from '@jarvis/apple';
import { Effect } from 'effect';
import { RANGE_DAYS, addDays, dayKeyOf, dayStartMs, type AgendaRange } from '#lib/agenda/time.js';
import { runApple } from '#lib/server/apple-gateway.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => {
	const range: AgendaRange = url.searchParams.get('periodo') === 'semana' ? 'semana' : 'hoje';
	const requested = url.searchParams.get('calendario')?.trim() || null;

	const now = Date.now();
	const today = dayKeyOf(now);
	const from = new Date(dayStartMs(today)).toISOString();
	const to = new Date(dayStartMs(addDays(today, RANGE_DAYS[range]))).toISOString();

	// Sequential on purpose: the first call is the one macOS may prompt for. An unknown calendar
	// (renamed, deleted, edited URL) falls back to every calendar instead of failing.
	const board = runApple(
		Calendar.use((calendar) =>
			Effect.gen(function* () {
				const calendars = yield* calendar.calendars;
				const selected = requested !== null && calendars.includes(requested) ? requested : null;
				const events = yield* calendar.events(selected === null ? { from, to } : { from, to, calendar: selected });
				return { calendars, calendar: selected, events };
			})
		)
	);

	// Streamed: Calendar can take seconds to answer (or wait on the consent dialog); the page shows up at once.
	return { range, now, today, board };
};
