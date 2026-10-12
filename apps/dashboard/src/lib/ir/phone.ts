/** Brazilian-first phone helpers shared by the form (live hint) and the server action (authoritative check). */

export type CallVia = 'phone' | 'facetime-audio';

export const callViaLabels: Record<CallVia, string> = {
	phone: 'iPhone',
	'facetime-audio': 'FaceTime áudio'
};

export const isCallVia = (value: unknown): value is CallVia => value === 'phone' || value === 'facetime-audio';

const E164 = /^\+[1-9]\d{7,14}$/;

/** Turns what a person types or pastes into E.164. Without a `+`, the number is taken as Brazilian. */
export const toE164 = (raw: string): string => {
	const text = raw.normalize('NFKC').trim();
	const digits = text.replace(/\D/g, '');
	if (digits === '') return '';
	if (text.startsWith('+')) return `+${digits}`;
	// 0 is the national trunk prefix (0 11 9…); it is never part of the number.
	const national = digits.replace(/^0+/, '');
	if (national.startsWith('55') && national.length >= 12) return `+${national}`;
	return `+55${national}`;
};

/** `+5511999998888` becomes `+55 11 99999-8888`; anything that is not a full Brazilian number is only grouped by country code. */
export const formatE164 = (e164: string): string => {
	if (!e164.startsWith('+55')) return e164;
	const national = e164.slice(3);
	if (national.length === 11) return `+55 ${national.slice(0, 2)} ${national.slice(2, 7)}-${national.slice(7)}`;
	if (national.length === 10) return `+55 ${national.slice(0, 2)} ${national.slice(2, 6)}-${national.slice(6)}`;
	return national === '' ? '+55' : `+55 ${national}`;
};

export type PhoneCheck =
	| { ok: true; e164: string; display: string }
	| { ok: false; e164: string; display: string; hint: string };

export const checkPhone = (raw: string): PhoneCheck => {
	const e164 = toE164(raw);
	const display = formatE164(e164);
	const fail = (hint: string): PhoneCheck => ({ ok: false, e164, display, hint });

	if (e164 === '') return fail('Digite o DDD e o número. Sem código de país, assumimos +55.');

	if (e164.startsWith('+55')) {
		const national = e164.slice(3);
		if (national.length < 10) return fail(`Faltam ${10 - national.length} dígito(s) ou mais: DDD + número.`);
		if (national.length > 11) return fail('Número brasileiro com dígitos demais: DDD (2) + 8 ou 9 dígitos.');
		if (!/^[1-9][1-9]/.test(national)) return fail('DDD inválido. Use dois dígitos, de 11 a 99.');
		if (national.length === 11 && national[2] !== '9') return fail('Celular com 9 dígitos começa com 9 depois do DDD.');
		return { ok: true, e164, display };
	}

	return E164.test(e164)
		? { ok: true, e164, display }
		: fail('Número internacional inválido. Use + e de 8 a 15 dígitos.');
};
