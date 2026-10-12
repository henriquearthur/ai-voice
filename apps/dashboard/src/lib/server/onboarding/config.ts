import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeConfig, type OnboardingConfig } from '#lib/onboarding/model.js';
import type { JarvisPaths } from './paths.js';

/**
 * Chaves do ~/.config/jarvis/jarvis.env que o onboarding mantém. São as mesmas do scripts/setup.sh
 * (CONFIG_KEYS) mais ESCUTA_STT, que o instalar.sh da Escuta lê. Outras chaves do arquivo ficam como estão.
 */
export const ENV_KEYS = [
	'AI_VOICE_LOCALE',
	'AI_VOICE_AMAZON_PAGE',
	'AI_VOICE_OUTPUT',
	'AI_VOICE_DEFAULT_DEVICE',
	'AI_VOICE_TTS_VOICE',
	'JARVIS_CALLBACK_PORT',
	'ESCUTA_PANE',
	'ESCUTA_ORQUESTRADOR',
	'ESCUTA_MIC',
	'ESCUTA_STT'
] as const;

/** Valores do jarvis.env para uma config. Sem segredos: eles vão para o Keychain. */
export function envValues(cfg: OnboardingConfig): Record<(typeof ENV_KEYS)[number], string> {
	return {
		AI_VOICE_LOCALE: cfg.locale,
		AI_VOICE_AMAZON_PAGE: cfg.echo.amazonPage,
		AI_VOICE_OUTPUT: cfg.modulos.echo ? cfg.echo.output : 'mac',
		AI_VOICE_DEFAULT_DEVICE: cfg.modulos.echo ? cfg.echo.defaultDevice : '',
		AI_VOICE_TTS_VOICE: cfg.voz.voice,
		JARVIS_CALLBACK_PORT: String(cfg.callbackPort),
		ESCUTA_PANE: '',
		ESCUTA_ORQUESTRADOR: cfg.escuta.orquestrador,
		ESCUTA_MIC: cfg.escuta.mic,
		ESCUTA_STT: cfg.escuta.stt
	};
}

/** Lê KEY="valor" de um arquivo no formato do jarvis.env (o mesmo parser do setup.sh). */
export function parseEnv(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#') || !line.includes('=')) continue;
		const key = line.slice(0, line.indexOf('='));
		if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
		out.set(key, line.slice(key.length + 1).replace(/^"/, '').replace(/"$/, ''));
	}
	return out;
}

/** Novo jarvis.env: as chaves do onboarding com os valores da config, as demais preservadas do arquivo atual. */
export function renderEnv(cfg: OnboardingConfig, current = ''): string {
	const merged = parseEnv(current);
	for (const [k, v] of Object.entries(envValues(cfg))) merged.set(k, v);
	const lines = [
		'# Ajustes do Jarvis neste Mac. Gravado pelo onboarding do Jarvis.app e pelo scripts/setup.sh; pode editar à mão.',
		'# Sem segredos aqui: a sessão da Amazon fica em ~/.local/share/ai-voice e as chaves do Grok Bot no Keychain.'
	];
	for (const [k, v] of merged) {
		if (/[\n"$`\\]/.test(v)) throw new Error(`valor inválido em ${k}`);
		lines.push(`${k}="${v}"`);
	}
	return lines.join('\n') + '\n';
}

/** Grava com modo 0600 por troca atômica (escreve ao lado e renomeia). */
export function writePrivate(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, content, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, path);
}

export function readConfig(paths: JarvisPaths): OnboardingConfig | null {
	try {
		return normalizeConfig(JSON.parse(readFileSync(paths.configJson, 'utf8')));
	} catch {
		return null;
	}
}

/**
 * O Jarvis já está configurado nesta máquina? Sim quando o onboarding foi concluído, ou quando é uma
 * instalação feita antes do onboarding existir (jarvis.env + LaunchAgent do dashboard), para não
 * jogar quem já usa o Jarvis de volta à tela de boas-vindas.
 */
export function isConfigured(paths: JarvisPaths, exists: (p: string) => boolean = existsSync): boolean {
	const cfg = exists(paths.configJson) ? readConfig(paths) : null;
	if (cfg?.concluidoEm) return true;
	if (cfg) return false;
	return exists(paths.jarvisEnv) && exists(`${paths.launchAgents}/dev.jarvis.dashboard.plist`);
}

/** Grava config.json e jarvis.env (ambos 0600). */
export function saveConfig(paths: JarvisPaths, cfg: OnboardingConfig): void {
	writePrivate(paths.configJson, JSON.stringify(cfg, null, '\t') + '\n');
	const current = existsSync(paths.jarvisEnv) ? readFileSync(paths.jarvisEnv, 'utf8') : '';
	writePrivate(paths.jarvisEnv, renderEnv(cfg, current));
}
