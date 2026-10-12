/** How a reminder's due date reads on screen, relative to the viewer's today. */
export type Due = {
	readonly day: string;
	/** The same day in a few letters, for a narrow column: "hoje", "qua", "12 nov". */
	readonly brief: string;
	readonly time: string | null;
	readonly overdue: boolean;
	readonly today: boolean;
	/** Calendar days from the viewer's today: 0 today, 1 tomorrow, negative in the past. */
	readonly days: number;
	/** Milliseconds, for ordering; all-day reminders sort at the start of their day. */
	readonly at: number;
	readonly full: string;
};

const ALL_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

const weekday = new Intl.DateTimeFormat('pt-BR', { weekday: 'long' });
const weekdayShort = new Intl.DateTimeFormat('pt-BR', { weekday: 'short' });
const short = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short' });
const withYear = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short', year: 'numeric' });
const clock = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const long = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full' });
const longTimed = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeStyle: 'short' });

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

// Calendar days, not 24h spans: DST shifts would otherwise turn "amanhã" into "hoje".
const daysBetween = (from: Date, to: Date) =>
	Math.round((Date.UTC(to.getFullYear(), to.getMonth(), to.getDate()) - Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())) / DAY_MS);

const dayLabel = (date: Date, now: Date) => {
	const diff = daysBetween(now, date);
	if (diff === 0) return 'hoje';
	if (diff === 1) return 'amanhã';
	if (diff === -1) return 'ontem';
	if (diff > 1 && diff < 7) return weekday.format(date);
	return (date.getFullYear() === now.getFullYear() ? short : withYear).format(date).replaceAll('.', '');
};

const briefLabel = (date: Date, now: Date) => {
	const diff = daysBetween(now, date);
	if (diff >= -1 && diff <= 1) return dayLabel(date, now);
	if (diff > 1 && diff < 7) return weekdayShort.format(date).replaceAll('.', '');
	return (date.getFullYear() === now.getFullYear() ? short : withYear).format(date).replaceAll('.', '').replace(/ de /g, ' ');
};

/** `due` is `YYYY-MM-DD` for an all-day reminder or an ISO instant with offset for a timed one. */
export const describeDue = (due: string, now: Date): Due | null => {
	const allDay = ALL_DAY.exec(due);
	if (allDay !== null) {
		const [year, month, day] = allDay.slice(1).map(Number) as [number, number, number];
		const date = new Date(year, month - 1, day);
		return {
			day: dayLabel(date, now),
			brief: briefLabel(date, now),
			time: null,
			overdue: date < startOfDay(now),
			today: daysBetween(now, date) === 0,
			days: daysBetween(now, date),
			at: date.getTime(),
			full: long.format(date)
		};
	}
	const date = new Date(due);
	if (Number.isNaN(date.getTime())) return null;
	return {
		day: dayLabel(date, now),
		brief: briefLabel(date, now),
		time: clock.format(date),
		overdue: date < now,
		today: daysBetween(now, date) === 0,
		days: daysBetween(now, date),
		at: date.getTime(),
		full: longTimed.format(date)
	};
};

/** Where a reminder sits on the road ahead; the order of the keys is the order on screen. */
export const HORIZONS = {
	overdue: 'Atrasados',
	today: 'Hoje',
	tomorrow: 'Amanhã',
	week: 'Próximos dias',
	later: 'Mais adiante',
	undated: 'Sem data',
	done: 'Concluídos'
} as const;

export type Horizon = keyof typeof HORIZONS;

export const horizonOf = (completed: boolean, due: Due | null): Horizon => {
	if (completed) return 'done';
	if (due === null) return 'undated';
	if (due.overdue) return 'overdue';
	if (due.days === 0) return 'today';
	if (due.days === 1) return 'tomorrow';
	return due.days < 7 ? 'week' : 'later';
};

/** `YYYY-MM-DD` of the local day `offset` days from `now`, the value a date input takes. */
export const isoDay = (now: Date, offset = 0) => {
	const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
