import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { arch, homedir, release } from 'node:os';
import { DEFAULT_CONFIG, type OnboardingConfig, type OnboardingState } from '#lib/onboarding/model.js';
import { isConfigured, readConfig } from './config.js';
import { detectAll, parseMicrophones, PARAKEET_DIR, VAD_DIR, type Probe } from './detect.js';
import { downloadModel, KOKORO_SPEC, PARAKEET_SPEC, VAD_SPEC } from './hf-download.js';
import { JobRegistry, type JobContext } from './jobs.js';
import { findRepo, jarvisPaths, type JarvisPaths } from './paths.js';
import { agentPath, renderAgent, renderTemplate, type TemplateAgent } from './plists.js';
import { secretsState } from './secrets.js';

const env: NodeJS.ProcessEnv = { ...process.env, HOME: process.env.HOME || homedir() };
export const paths: JarvisPaths = jarvisPaths(env, findRepo(env));

/** Onde procurar executáveis além do PATH (o launchd dá um PATH curto ao servidor). */
const extraDirs = () => [
	join(paths.home, '.bun', 'bin'),
	paths.localBin,
	join(paths.home, '.cargo', 'bin'),
	'/opt/homebrew/bin',
	'/usr/local/bin',
	'/usr/bin',
	'/bin'
];
const searchPath = () => [...new Set([...(env.PATH ?? '').split(delimiter).filter(Boolean), ...extraDirs()])];
const childEnv = (): NodeJS.ProcessEnv => ({ ...env, PATH: searchPath().join(delimiter) });

export const realProbe: Probe = {
	which(name) {
		for (const dir of searchPath()) {
			const p = join(dir, name);
			try {
				if (statSync(p).isFile()) return p;
			} catch {
				/* segue */
			}
		}
		return null;
	},
	exists: (p) => existsSync(p),
	size(p) {
		try {
			return statSync(p).size;
		} catch {
			return 0;
		}
	},
	run(cmd, args) {
		const r = spawnSync(cmd, args as string[], { encoding: 'utf8', timeout: 8_000, env: childEnv() });
		return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
	},
	arch: arch(),
	// Darwin 25 = macOS 26.
	macosMajor: Number(release().split('.')[0]) + 1,
	uid: process.getuid?.() ?? 501
};

const g = globalThis as unknown as { __jarvisOnboardingJobs?: JobRegistry };
export const jobs = (g.__jarvisOnboardingJobs ??= new JobRegistry(paths.onboardingDir));

export function currentConfig(): OnboardingConfig {
	return readConfig(paths) ?? DEFAULT_CONFIG;
}

export function onboardingState(): OnboardingState {
	const mic = realProbe.run('/usr/sbin/system_profiler', ['SPAudioDataType', '-json']);
	return {
		configurado: isConfigured(paths),
		config: currentConfig(),
		itens: detectAll(realProbe, paths),
		jobs: jobs.list(),
		segredos: secretsState(),
		microfones: mic.code === 0 ? parseMicrophones(mic.out) : [],
		home: paths.home
	};
}

// ---------------------------------------------------------------- tarefas por item

const bun = () => realProbe.which('bun') ?? join(paths.home, '.bun', 'bin', 'bun');

async function loadAgent(ctx: JobContext, label: string) {
	const domain = `gui/${realProbe.uid}`;
	await ctx.sh('/bin/launchctl', ['bootout', `${domain}/${label}`]).catch(() => ctx.log(`${label} não estava carregado`));
	for (let i = 0; i < 40 && realProbe.run('/bin/launchctl', ['print', `${domain}/${label}`]).code === 0; i++) {
		await new Promise((r) => setTimeout(r, 250));
	}
	// O bootout é assíncrono: o bootstrap logo depois pode dar "Bootstrap failed: 5".
	for (let tentativa = 1; ; tentativa++) {
		try {
			await ctx.sh('/bin/launchctl', ['bootstrap', domain, agentPath(paths, label)]);
			ctx.log(`${label} carregado`);
			return;
		} catch (e) {
			if (tentativa >= 5) throw e;
			await new Promise((r) => setTimeout(r, 1000));
		}
	}
}

async function writeTemplateAgent(ctx: JobContext, label: TemplateAgent) {
	const xml = renderAgent(label, { paths, bun: bun(), config: currentConfig() });
	const dest = agentPath(paths, label);
	mkdirSync(paths.launchAgents, { recursive: true });
	writeFileSync(dest, xml, { mode: 0o644 });
	await ctx.sh('/usr/bin/plutil', ['-lint', dest]);
	ctx.log(`gravado ${dest}`);
	await loadAgent(ctx, label);
}

const shell = (ctx: JobContext, script: string) => ctx.sh('/bin/bash', ['-c', script]);

type Task = { titulo: string; run: (ctx: JobContext) => Promise<void> };

export const TASKS: Record<string, Task> = {
	bun: { titulo: 'Instalando o Bun', run: (ctx) => shell(ctx, 'curl -fsSL https://bun.sh/install | bash') },
	claude: { titulo: 'Instalando o Claude Code', run: (ctx) => shell(ctx, 'curl -fsSL https://claude.ai/install.sh | bash') },
	herdr: { titulo: 'Instalando o herdr', run: (ctx) => shell(ctx, 'curl -fsSL https://herdr.dev/install.sh | sh') },
	xcode: {
		titulo: 'Xcode Command Line Tools',
		async run(ctx) {
			await ctx.sh('/usr/bin/xcode-select', ['--install']).catch(() => undefined);
			ctx.log('O macOS abriu a janela de instalação: conclua por lá e toque em "Detectar de novo".');
		}
	},
	python: {
		titulo: 'Instalando o uv (Python 3.12)',
		run: (ctx) =>
			realProbe.which('brew')
				? ctx.sh(realProbe.which('brew')!, ['install', 'uv'])
				: shell(ctx, 'curl -LsSf https://astral.sh/uv/install.sh | sh')
	},
	tailscale: {
		titulo: 'Instalando o Tailscale',
		run: (ctx) => ctx.sh(realProbe.which('brew') ?? '/opt/homebrew/bin/brew', ['install', '--cask', 'tailscale'])
	},
	kokoro: {
		titulo: 'Kokoro TTS (pf_dora)',
		async run(ctx) {
			ctx.etapa('Baixando o modelo (retoma de onde parou)');
			await downloadModel(KOKORO_SPEC(paths.kokoroDir), {
				log: ctx.log,
				signal: ctx.signal,
				progress: (p) => ctx.progresso((p.baixado / p.total) * 0.8)
			});
			ctx.etapa('Criando o venv Python com as versões travadas');
			ctx.progresso(0.85);
			await ctx.sh(join(paths.repo, 'services', 'tts', 'install.sh'), [], { env: { JARVIS_TTS_HOME: paths.ttsHome } });
		}
	},
	parakeet: {
		titulo: 'Parakeet TDT v3 + VAD Silero',
		async run(ctx) {
			ctx.etapa('Baixando a VAD Silero');
			await downloadModel(VAD_SPEC(join(paths.fluidModels, VAD_DIR)), {
				log: ctx.log,
				signal: ctx.signal,
				progress: (p) => ctx.progresso((p.baixado / p.total) * 0.02)
			});
			ctx.etapa('Baixando o Parakeet TDT v3 (retoma de onde parou)');
			await downloadModel(PARAKEET_SPEC(join(paths.fluidModels, PARAKEET_DIR)), {
				log: ctx.log,
				signal: ctx.signal,
				progress: (p) => ctx.progresso(0.02 + (p.baixado / p.total) * 0.98)
			});
		}
	},
	'dev.jarvis.dashboard': {
		titulo: 'Dashboard como LaunchAgent',
		async run(ctx) {
			ctx.etapa('Build, helper do Calendário e plist (apps/dashboard/scripts/install-launchagent.sh)');
			await ctx.sh(join(paths.repo, 'apps', 'dashboard', 'scripts', 'install-launchagent.sh'), [], {
				cwd: join(paths.repo, 'apps', 'dashboard')
			});
		}
	},
	'dev.jarvis.tts': { titulo: 'Servidor de voz', run: (ctx) => writeTemplateAgent(ctx, 'dev.jarvis.tts') },
	'dev.jarvis.callback': {
		titulo: 'Callback do Grok Bot',
		async run(ctx) {
			mkdirSync(join(paths.data, 'callback', 'logs'), { recursive: true });
			await writeTemplateAgent(ctx, 'dev.jarvis.callback');
		}
	},
	'dev.jarvis.escuta': {
		titulo: 'Escuta',
		async run(ctx) {
			ctx.etapa('swift build, Escuta.app e LaunchAgent (apps/escuta/scripts/instalar.sh)');
			await ctx.sh(join(paths.repo, 'apps', 'escuta', 'scripts', 'instalar.sh'), ['--carregar'], {
				env: { JARVIS_CONFIG: paths.jarvisEnv }
			});
		}
	},
	apple: {
		titulo: 'Helper do Calendário',
		run: (ctx) => ctx.sh(bun(), ['run', 'build:native'], { cwd: join(paths.repo, 'packages', 'apple') })
	},
	mcp: {
		titulo: 'MCP ai-voice no Claude Code',
		async run(ctx) {
			const cfg = currentConfig();
			mkdirSync(paths.localBin, { recursive: true });
			for (const f of ['jarvis-fala', 'jarvis-fala-resposta', 'jarvis-avisa']) {
				const dest = join(paths.localBin, f);
				copyFileSync(join(paths.repo, 'services', 'bin', f), dest);
				chmodSync(dest, 0o755);
			}
			const stdio = join(paths.localBin, 'jarvis-mcp-stdio');
			const tpl = readFileSync(join(paths.repo, 'services', 'bin', 'jarvis-mcp-stdio.in'), 'utf8');
			// Script de shell, não XML: sem escape.
			writeFileSync(stdio, renderTemplate(tpl, { BUN: bun(), REPO: paths.repo }, (s) => s), { mode: 0o700 });
			ctx.log(`gravado ${stdio}`);
			const claude = realProbe.which('claude');
			if (!claude) throw new Error('o Claude Code não foi encontrado');
			if (realProbe.run(claude, ['mcp', 'get', 'ai-voice']).code === 0) {
				ctx.log('o MCP ai-voice já está registrado');
				return;
			}
			const envs = [
				'AI_VOICE_ENABLE_SPEECH=1',
				`AI_VOICE_LOCALE=${cfg.locale}`,
				`AI_VOICE_AMAZON_PAGE=${cfg.echo.amazonPage}`,
				`AI_VOICE_OUTPUT=${cfg.modulos.echo ? cfg.echo.output : 'mac'}`,
				`AI_VOICE_TTS_VOICE=${cfg.voz.voice}`,
				...(cfg.modulos.echo && cfg.echo.defaultDevice ? [`AI_VOICE_DEFAULT_DEVICE=${cfg.echo.defaultDevice}`] : [])
			].flatMap((e) => ['--env', e]);
			await ctx.sh(claude, ['mcp', 'add', 'ai-voice', '-s', 'user', ...envs, '--', stdio]);
		}
	},
	'echo-login': {
		titulo: 'Login na Amazon',
		async run(ctx) {
			ctx.log('Abra http://127.0.0.1:3456/ e entre na Amazon. A senha vai só para a Amazon, pelo navegador.');
			await ctx.sh(bun(), ['apps/mcp/src/main.ts', 'login'], {
				cwd: paths.repo,
				env: { AI_VOICE_AMAZON_PAGE: currentConfig().echo.amazonPage }
			});
		}
	}
};

export function startTask(item: string) {
	const task = TASKS[item];
	if (!task) throw new Error(`item desconhecido: ${item}`);
	return jobs.start(item, task.titulo, task.run, childEnv());
}

