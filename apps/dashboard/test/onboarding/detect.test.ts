import { describe, expect, test } from 'vitest';
import { join } from 'node:path';
import { DEFAULT_CONFIG, itensNecessarios, normalizeConfig } from '#lib/onboarding/model.js';
import { detectAll, KOKORO_WEIGHTS, PARAKEET_DIR, PARAKEET_FILES, parseMicrophones, VAD_DIR, VAD_FILES, type Probe } from '#lib/server/onboarding/detect.js';
import { jarvisPaths } from '#lib/server/onboarding/paths.js';

const HOME = '/Users/amigo';
const paths = jarvisPaths({ HOME }, '/Users/amigo/code/jarvis');

type Fake = { bins?: Record<string, string>; files?: Record<string, number>; loaded?: string[]; mcp?: boolean; clt?: boolean; arch?: string; macos?: number };

function probe(f: Fake = {}): Probe {
	const files = f.files ?? {};
	return {
		which: (n) => f.bins?.[n] ?? null,
		exists: (p) => p in files,
		size: (p) => files[p] ?? 0,
		run(cmd, args) {
			if (cmd === '/bin/launchctl') {
				const label = args[1]!.split('/').pop()!;
				return { code: f.loaded?.includes(label) ? 0 : 113, out: '' };
			}
			if (cmd === '/usr/bin/xcode-select') return f.clt ? { code: 0, out: '/Library/Developer/CommandLineTools\n' } : { code: 2, out: '' };
			if (args[0] === 'mcp') return { code: f.mcp ? 0 : 1, out: '' };
			if (args[0] === '--version') return { code: 0, out: `${cmd.split('/').pop()} 1.0.0\n` };
			return { code: 1, out: '' };
		},
		arch: f.arch ?? 'arm64',
		macosMajor: f.macos ?? 26,
		uid: 501
	};
}

const byId = (items: ReturnType<typeof detectAll>) => Object.fromEntries(items.map((i) => [i.id, i]));

describe('detectAll numa máquina nova', () => {
	const items = byId(detectAll(probe(), paths));

	test('o essencial (Bun, Claude Code, dashboard) aparece como faltando, com ação', () => {
		for (const id of ['bun', 'claude', 'dev.jarvis.dashboard']) {
			expect(items[id]!.status).toBe('falta');
			expect(items[id]!.essencial).toBe(true);
			expect(items[id]!.acao).toBeTruthy();
		}
	});

	test('modelos e serviços opcionais ficam atrelados aos seus módulos', () => {
		expect(items.kokoro!.modulos).toEqual(['voz']);
		expect(items.parakeet!.modulos).toEqual(['escuta']);
		expect(items['dev.jarvis.callback']!.modulos).toEqual(['grok']);
		expect(items.kokoro!.acao).toBe('Baixar');
	});

	test('sem Claude Code não há como registrar o MCP', () => {
		expect(items.mcp!.acao).toBeUndefined();
	});

	test('no modo mínimo só o essencial é necessário', () => {
		const need = itensNecessarios(Object.values(items), DEFAULT_CONFIG).map((i) => i.id).sort();
		expect(need).toEqual(['bun', 'claude', 'dev.jarvis.dashboard']);
	});

	test('ligar a Escuta pede herdr, Xcode CLT, Parakeet e o LaunchAgent da Escuta', () => {
		const cfg = normalizeConfig({ modo: 'completo', modulos: { escuta: true } });
		const need = itensNecessarios(Object.values(items), cfg).map((i) => i.id);
		expect(need).toEqual(expect.arrayContaining(['herdr', 'xcode', 'parakeet', 'dev.jarvis.escuta']));
		expect(need).not.toContain('kokoro');
	});
});

describe('detectAll numa máquina pronta', () => {
	const files: Record<string, number> = {
		[join(paths.kokoroDir, KOKORO_WEIGHTS)]: 327_000_000,
		[join(paths.kokoroDir, 'voices', 'pf_dora.safetensors')]: 500_000,
		[join(paths.ttsHome, '.venv', 'bin', 'python')]: 1,
		[join(paths.localBin, 'jarvis-mcp-stdio')]: 1,
		[paths.calendarHelper]: 1
	};
	for (const f of PARAKEET_FILES) files[join(paths.fluidModels, PARAKEET_DIR, f)] = 1;
	for (const f of VAD_FILES) files[join(paths.fluidModels, VAD_DIR, f)] = 1;
	for (const l of ['dashboard', 'tts', 'escuta', 'callback']) files[join(paths.launchAgents, `dev.jarvis.${l}.plist`)] = 1;
	const items = byId(
		detectAll(
			probe({
				files,
				bins: { bun: `${HOME}/.bun/bin/bun`, claude: `${HOME}/.local/bin/claude`, herdr: `${HOME}/.local/bin/herdr`, uv: '/opt/homebrew/bin/uv' },
				loaded: ['dev.jarvis.dashboard', 'dev.jarvis.tts', 'dev.jarvis.escuta'],
				mcp: true,
				clt: true
			}),
			paths
		)
	);

	test('tudo o que existe vira ok, sem botão', () => {
		for (const id of ['bun', 'claude', 'herdr', 'python', 'xcode', 'kokoro', 'parakeet', 'dev.jarvis.dashboard', 'dev.jarvis.tts', 'mcp', 'apple']) {
			expect([id, items[id]!.status]).toEqual([id, 'ok']);
			expect(items[id]!.acao).toBeUndefined();
		}
	});

	test('plist gravado mas não carregado fica parcial, com "Carregar"', () => {
		expect(items['dev.jarvis.callback']!.status).toBe('parcial');
		expect(items['dev.jarvis.callback']!.acao).toBe('Carregar');
	});

	test('o detalhe mostra versão e caminho detectados', () => {
		expect(items.bun!.detalhe).toContain(`${HOME}/.bun/bin/bun`);
		expect(items.bun!.detalhe).toContain('1.0.0');
	});
});

test('Kokoro pela metade (pesos truncados) não conta como baixado', () => {
	const items = byId(detectAll(probe({ files: { [join(paths.kokoroDir, KOKORO_WEIGHTS)]: 10_000_000, [join(paths.kokoroDir, 'voices', 'pf_dora.safetensors')]: 1 } }), paths));
	expect(items.kokoro!.status).toBe('falta');
});

test('Mac Intel: a voz Kokoro não se aplica; macOS 15: a Escuta não se aplica', () => {
	const items = byId(detectAll(probe({ arch: 'x86_64', macos: 15 }), paths));
	expect(items.kokoro!.status).toBe('nao-se-aplica');
	expect(items.python!.status).toBe('nao-se-aplica');
	expect(items['dev.jarvis.escuta']!.status).toBe('nao-se-aplica');
});

test('nenhum caminho detectado aponta para outro usuário', () => {
	const text = JSON.stringify(detectAll(probe(), paths)) + JSON.stringify(paths);
	expect(text).not.toContain('fernandodudata');
	expect(paths.fluidModels).toBe('/Users/amigo/Library/Application Support/FluidAudio/Models');
});

test('parseMicrophones lê só as entradas e marca a padrão', () => {
	const json = JSON.stringify({
		SPAudioDataType: [
			{
				_items: [
					{ _name: 'Alto-falantes (MacBook Pro)', coreaudio_device_output: 2 },
					{ _name: 'HyperX Cloud III', coreaudio_device_input: 1, coreaudio_default_audio_input_device: 'spaudio_yes' },
					{ _name: 'Microfone (MacBook Pro)', coreaudio_device_input: 1 }
				]
			}
		]
	});
	expect(parseMicrophones(json)).toEqual([
		{ nome: 'HyperX Cloud III', padrao: true },
		{ nome: 'Microfone (MacBook Pro)', padrao: false }
	]);
	expect(parseMicrophones('não é json')).toEqual([]);
});
