import type { MacVoiceStatus } from './failure.js';

/** Kokoro ids read `pf_dora` (language, gender, name): the person reads only the name. */
export const voiceName = (id: string) => {
	const name = id.replace(/^[a-z]{2}_/u, '');
	return name.charAt(0).toLocaleUpperCase('pt-BR') + name.slice(1);
};

/** One line for the Mac voice: who speaks and with which engine. */
export const describeVoice = (voice: MacVoiceStatus) =>
	voice.engine === 'kokoro' ? `${voiceName(voice.voice)} · Kokoro` : `${voice.voice} · voz do sistema`;
