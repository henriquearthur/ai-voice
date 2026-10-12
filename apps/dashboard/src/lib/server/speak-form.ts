import { MAX_TEXT_LENGTH, SpeechText } from '@jarvis/alexa';
import { Result, Schema } from 'effect';

/** The radio value that means "this Mac". Any other non-empty value is an Echo serial. */
export const MAC_ROUTE = 'mac';

const SpeakForm = Schema.Struct({
	text: SpeechText,
	deviceSerial: Schema.optionalKey(Schema.NonEmptyString)
});

export type SpeakInput = typeof SpeakForm.Type;

const decode = Schema.decodeUnknownResult(SpeakForm);

const field = (data: FormData, name: string) => {
	const value = data.get(name);
	return typeof value === 'string' ? value : '';
};

/**
 * Reads the speak form. `device` is `mac` (or missing) for this Mac, or an Echo serial.
 * The raw values come back too so a rejected form keeps what was typed.
 */
export const parseSpeakForm = (data: FormData) => {
	const text = field(data, 'text');
	const raw = field(data, 'device');
	const device = raw === '' ? MAC_ROUTE : raw;
	const result = decode(device === MAC_ROUTE ? { text } : { text, deviceSerial: device });
	return Result.isSuccess(result)
		? ({ ok: true, input: result.success, text, device } as const)
		: ({ ok: false, message: describe(text), text, device } as const);
};

const describe = (text: string) => {
	if (text.trim() === '') return 'Escreva o que deve ser falado.';
	if (text.length > MAX_TEXT_LENGTH) return `O texto passa de ${MAX_TEXT_LENGTH.toLocaleString('pt-BR')} caracteres.`;
	return 'Use texto simples, sem os sinais < e >.';
};
