import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Todos os caminhos do onboarding, derivados do HOME e da raiz do repositório desta máquina.
 * Nada de caminho de usuário fixo: em outro Mac, os mesmos nomes caem no HOME de quem roda.
 */
export type JarvisPaths = {
	readonly home: string;
	readonly repo: string;
	readonly configDir: string;
	/** Marca de "onboarding feito" e as escolhas da pessoa (sem segredos). */
	readonly configJson: string;
	/** O arquivo que scripts/setup.sh e os instaladores já leem. */
	readonly jarvisEnv: string;
	readonly data: string;
	readonly onboardingDir: string;
	readonly ttsHome: string;
	readonly kokoroDir: string;
	readonly fluidModels: string;
	readonly launchAgents: string;
	readonly localBin: string;
	readonly calendarHelper: string;
	readonly amazonSession: string;
};

export function jarvisPaths(env: Record<string, string | undefined>, repo: string): JarvisPaths {
	const home = env.HOME;
	if (!home) throw new Error('HOME não definido');
	const configDir = join(home, '.config', 'jarvis');
	const data = join(home, '.local', 'share', 'jarvis');
	const ttsHome = env.JARVIS_TTS_HOME || join(data, 'tts');
	return {
		home,
		repo,
		configDir,
		configJson: env.JARVIS_ONBOARDING_CONFIG || join(configDir, 'config.json'),
		jarvisEnv: env.JARVIS_CONFIG || join(configDir, 'jarvis.env'),
		data,
		onboardingDir: join(data, 'onboarding'),
		ttsHome,
		kokoroDir: join(ttsHome, 'models', 'kokoro-82m-bf16'),
		fluidModels: join(home, 'Library', 'Application Support', 'FluidAudio', 'Models'),
		launchAgents: join(home, 'Library', 'LaunchAgents'),
		localBin: join(home, '.local', 'bin'),
		calendarHelper: join(data, 'bin', 'calendar-events'),
		amazonSession: join(env.AI_VOICE_STATE_DIR || join(home, '.local', 'share', 'ai-voice'), 'session.json')
	};
}

/**
 * Raiz do repositório: JARVIS_REPO, senão sobe a partir deste arquivo (dev) ou do cwd (o LaunchAgent
 * do dashboard roda com WorkingDirectory = apps/dashboard) até achar scripts/setup.sh.
 */
export function findRepo(env: Record<string, string | undefined>, cwd = process.cwd()): string {
	if (env.JARVIS_REPO && existsSync(join(env.JARVIS_REPO, 'scripts', 'setup.sh'))) return env.JARVIS_REPO;
	const starts = [cwd];
	try {
		starts.push(dirname(fileURLToPath(import.meta.url)));
	} catch {
		/* import.meta.url ausente em algum bundler: fica só o cwd */
	}
	for (const start of starts) {
		let dir = resolve(start);
		for (let i = 0; i < 8; i++) {
			if (existsSync(join(dir, 'scripts', 'setup.sh')) && existsSync(join(dir, 'apps', 'dashboard'))) return dir;
			const up = dirname(dir);
			if (up === dir) break;
			dir = up;
		}
	}
	return resolve(cwd, '..', '..');
}
