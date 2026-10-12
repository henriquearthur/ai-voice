import { Result, Schema } from 'effect';

export const TITLE_MAX = 500;
export const NOTES_MAX = 10_000;

// Same limits the Reminders service enforces, checked here so each field gets its own message.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const noControl = Schema.makeFilter<string>((value) => (CONTROL.test(value) ? 'control' : undefined));

const ReminderForm = Schema.Struct({
	title: Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(TITLE_MAX), noControl),
	list: Schema.optionalKey(Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(200), noControl)),
	date: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))),
	time: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\d{2}:\d{2}$/))),
	notes: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(NOTES_MAX), noControl))
});

export type ReminderValues = {
	readonly title: string;
	readonly list: string;
	readonly date: string;
	readonly time: string;
	readonly notes: string;
};

export type ReminderErrors = Partial<Record<'title' | 'due' | 'notes' | 'list', string>>;

export type ReminderInput = {
	readonly title: string;
	readonly list?: string;
	readonly due?: string;
	readonly notes?: string;
};

const decode = Schema.decodeUnknownResult(ReminderForm);

const field = (data: FormData, name: string) => {
	const value = data.get(name);
	return typeof value === 'string' ? value : '';
};

const present = <K extends string>(key: K, value: string) => (value.trim() === '' ? {} : { [key]: value });

/** Reads the add-reminder form; the raw values come back too so a rejected form keeps what was typed. */
export const parseReminderForm = (data: FormData) => {
	const values: ReminderValues = {
		title: field(data, 'title'),
		list: field(data, 'list'),
		date: field(data, 'date'),
		time: field(data, 'time'),
		notes: field(data, 'notes')
	};
	const result = decode({
		title: values.title,
		...present('list', values.list),
		...present('date', values.date),
		...present('time', values.time),
		...present('notes', values.notes)
	});
	const errors = describe(values);
	if (Result.isFailure(result) || Object.keys(errors).length > 0) {
		return { ok: false, values, errors: Object.keys(errors).length > 0 ? errors : fallback } as const;
	}
	const { title, list, date, time, notes } = result.success;
	// A date without time is an all-day reminder; with time it is local wall-clock time, which Reminders keeps as is.
	const due = date === undefined ? undefined : time === undefined ? date : `${date}T${time}`;
	const input: ReminderInput = {
		title,
		...(list === undefined ? {} : { list }),
		...(due === undefined ? {} : { due }),
		...(notes === undefined ? {} : { notes })
	};
	return { ok: true, values, input } as const;
};

const fallback: ReminderErrors = { title: 'Revise os campos e tente de novo.' };

const describe = (values: ReminderValues): ReminderErrors => {
	const errors: { -readonly [K in keyof ReminderErrors]: string } = {};
	const title = values.title.trim();
	if (title === '') errors.title = 'Dê um título ao lembrete.';
	else if (title.length > TITLE_MAX) errors.title = `O título passa de ${TITLE_MAX} caracteres.`;
	else if (CONTROL.test(title)) errors.title = 'Tire os caracteres invisíveis do título.';

	if (values.list.length > 200 || CONTROL.test(values.list)) errors.list = 'Escolha uma lista da relação.';

	if (values.time !== '' && values.date === '') errors.due = 'Escolha o dia para usar um horário.';
	else if (values.date !== '' && !isRealDate(values.date)) errors.due = 'Essa data não existe no calendário.';
	else if (values.time !== '' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(values.time)) errors.due = 'Use um horário entre 00:00 e 23:59.';

	if (values.notes.length > NOTES_MAX) errors.notes = `As notas passam de ${NOTES_MAX.toLocaleString('pt-BR')} caracteres.`;
	else if (CONTROL.test(values.notes)) errors.notes = 'Tire os caracteres invisíveis das notas.';
	return errors;
};

const isRealDate = (value: string) => {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (match === null) return false;
	const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};
