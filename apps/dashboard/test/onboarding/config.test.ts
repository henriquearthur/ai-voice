import { describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, normalizeConfig } from '#lib/onboarding/model.js';
import { envValues, isConfigured, parseEnv, readConfig, renderEnv, saveConfig } from '#lib/server/onboarding/config.js';
import { isLocalRequest, isLoopback } from '#lib/server/onboarding/loopback.js';
import { addCommand, validSecret } from '#lib/server/onboarding/secrets.js';
import { jarvisPaths } from '#lib/server/onboarding/paths.js';

describe('normalizeConfig', () => {
	test('o padrão é o modo mínimo, com voz pf_dora a 1.15', () => {
		expect(normalizeConfig(undefined)).toEqual(DEFAULT_CONFIG);
		expect(DEFAULT_CONFIG.voz).toEqual({ voice: 'pf_dora', speed: 1.15 });
	});

	test('modo mínimo desliga todos os módulos, mesmo que venham ligados', () => {
		const cfg = normalizeConfig({ modo: 'minimo', modulos: { voz: true, escuta: true } });
		expect(Object.values(cfg.modulos).every((v) => v === false)).toBe(true);
	});

	test('modo completo mantém só os módulos conhecidos', () => {
		const cfg = normalizeConfig({ modo: 'completo', modulos: { voz: true, hack: true } });
		expect(cfg.modulos.voz).toBe(true);
		expect('hack' in cfg.modulos).toBe(false);
	});

	test('descarta valores que quebrariam o jarvis.env ou um plist', () => {
		const cfg = normalizeConfig({
			modo: 'completo',
			escuta: { mic: 'x"; rm -rf ~', orquestrador: '$(id)' },
			echo: { amazonPage: 'evil.com', defaultDevice: 'G0 911' },
			voz: { voice: '../x', speed: 9 },
			callbackPort: 80
		});
		expect(cfg.escuta.mic).toBe('');
		expect(cfg.escuta.orquestrador).toBe('');
		expect(cfg.echo.amazonPage).toBe('amazon.com.br');
		expect(cfg.echo.defaultDevice).toBe('');
		expect(cfg.voz).toEqual({ voice: 'pf_dora', speed: 1.15 });
		expect(cfg.callbackPort).toBe(7348);
	});
});

describe('jarvis.env', () => {
	test('as chaves do onboarding seguem a config; Echo desligada fala no Mac', () => {
		const cfg = normalizeConfig({
			modo: 'completo',
			modulos: { escuta: true },
			escuta: { mic: 'HyperX', stt: 'apple', orquestrador: 'maestro' },
			echo: { output: 'echo', defaultDevice: 'ABC123' }
		});
		const env = envValues(cfg);
		expect(env.ESCUTA_MIC).toBe('HyperX');
		expect(env.ESCUTA_STT).toBe('apple');
		expect(env.ESCUTA_ORQUESTRADOR).toBe('maestro');
		expect(env.AI_VOICE_OUTPUT).toBe('mac');
		expect(env.AI_VOICE_DEFAULT_DEVICE).toBe('');
		expect(env.AI_VOICE_TTS_VOICE).toBe('pf_dora');
	});

	test('preserva as chaves que o onboarding não conhece e troca as dele', () => {
		const atual = '# comentário\nAI_VOICE_LOCALE="en-US"\nESCUTA_SILENCIO="0.9"\n';
		const out = parseEnv(renderEnv(DEFAULT_CONFIG, atual));
		expect(out.get('ESCUTA_SILENCIO')).toBe('0.9');
		expect(out.get('AI_VOICE_LOCALE')).toBe('pt-BR');
		expect(out.get('ESCUTA_STT')).toBe('parakeet');
	});

	test('o arquivo gerado não leva segredos nem nomes de serviço do Keychain', () => {
		expect(renderEnv(DEFAULT_CONFIG)).not.toMatch(/GROKBOT|grokbot|password/i);
	});
});

describe('gravação e primeira execução', () => {
	const fresh = () => {
		const home = mkdtempSync(join(tmpdir(), 'jarvis-onb-'));
		return jarvisPaths({ HOME: home }, '/repo');
	};

	test('máquina nova: não configurado', () => {
		expect(isConfigured(fresh())).toBe(false);
	});

	test('instalação anterior ao onboarding (jarvis.env + plist do dashboard) conta como configurada', () => {
		const p = fresh();
		mkdirSync(p.configDir, { recursive: true });
		mkdirSync(p.launchAgents, { recursive: true });
		writeFileSync(p.jarvisEnv, 'AI_VOICE_LOCALE="pt-BR"\n');
		expect(isConfigured(p)).toBe(false);
		writeFileSync(join(p.launchAgents, 'dev.jarvis.dashboard.plist'), '');
		expect(isConfigured(p)).toBe(true);
	});

	test('saveConfig grava config.json e jarvis.env com modo 0600; só conclui com concluidoEm', () => {
		const p = fresh();
		saveConfig(p, DEFAULT_CONFIG);
		expect(statSync(p.configJson).mode & 0o777).toBe(0o600);
		expect(statSync(p.jarvisEnv).mode & 0o777).toBe(0o600);
		expect(isConfigured(p)).toBe(false);
		saveConfig(p, { ...DEFAULT_CONFIG, concluidoEm: '2026-10-12T12:00:00Z' });
		expect(isConfigured(p)).toBe(true);
		expect(readConfig(p)?.concluidoEm).toBe('2026-10-12T12:00:00Z');
		expect(readFileSync(p.jarvisEnv, 'utf8')).toContain('AI_VOICE_TTS_VOICE="pf_dora"');
	});
});

describe('segredos e acesso local', () => {
	test('o valor vai pelo stdin do security, entre aspas; aspas e quebras de linha são recusadas', () => {
		expect(addCommand('grokbot-key', 'abc 123')).toBe('add-generic-password -U -a jarvis -s jarvis-grokbot-key -w "abc 123"\n');
		expect(validSecret('a"b')).toBe(false);
		expect(validSecret('a\nb')).toBe(false);
		expect(validSecret('')).toBe(false);
		expect(() => addCommand('grokbot-key', 'x\\y')).toThrow();
	});

	const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

	test('só pedidos do próprio Mac, com Host local e sem proxy, abrem o onboarding', () => {
		expect(isLoopback('127.0.0.1')).toBe(true);
		expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
		expect(isLoopback('192.168.0.10')).toBe(false);
		expect(isLocalRequest('127.0.0.1', headers({ host: '127.0.0.1:7350' }))).toBe(true);
		expect(isLocalRequest('::1', headers({ host: 'localhost:5173' }))).toBe(true);
		// tailscale serve encaminha de 127.0.0.1 com o Host da tailnet
		expect(isLocalRequest('127.0.0.1', headers({ host: 'mac.tail1234.ts.net' }))).toBe(false);
		expect(isLocalRequest('127.0.0.1', headers({ host: '127.0.0.1', 'x-forwarded-for': '100.64.0.2' }))).toBe(false);
		expect(isLocalRequest('100.64.0.2', headers({ host: '127.0.0.1' }))).toBe(false);
	});
});
