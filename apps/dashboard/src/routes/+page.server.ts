import { MAX_TEXT_LENGTH } from '@jarvis/alexa';
import { fail } from '@sveltejs/kit';
import type { AlexaFailure, SpeechReceipt } from '#lib/alexa/failure.js';
import { listDevices, readMacVoice, readSettings, speak } from '#lib/server/alexa-gateway.js';
import { parseSpeakForm } from '#lib/server/speak-form.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	// The Mac is the default output: its state is read up front (config plus a local health check).
	// The Echo roster is streamed, because Amazon can take seconds and the Mac does not need it.
	const [settings, voice] = await Promise.all([readSettings(), readMacVoice()]);
	const echoes = listDevices();
	return { settings, voice, echoes, maxLength: MAX_TEXT_LENGTH };
};

const status: Record<AlexaFailure['kind'], number> = {
	session: 401,
	device: 409,
	speech: 422,
	voice: 503,
	config: 424,
	unexpected: 424
};

export const actions = {
	speak: async ({ request }) => {
		const form = parseSpeakForm(await request.formData());
		if (!form.ok) return fail(400, { text: form.text, device: form.device, invalid: form.message });

		const outcome = await speak(form.input);
		if (!outcome.ok) {
			return fail(status[outcome.failure.kind], {
				text: form.text,
				device: form.device,
				failure: outcome.failure
			});
		}
		const receipt: SpeechReceipt = { ...outcome.value, text: form.input.text, at: Date.now() };
		return { device: form.device, accepted: receipt };
	}
} satisfies Actions;
