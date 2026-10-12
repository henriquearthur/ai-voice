import { describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_CONFIG, normalizeConfig } from '#lib/onboarding/model.js';
import { jarvisPaths } from '#lib/server/onboarding/paths.js';
import { defaultReader, renderAgent as render, renderTemplate, TEMPLATE_AGENTS, type PlistContext, type TemplateAgent } from '#lib/server/onboarding/plists.js';

// Os modelos de verdade do repositório (services/launchd/*.plist.in), renderizados para outro usuário.
const repo = resolve(import.meta.dirname, '..', '..', '..', '..');
// Lê os modelos deste checkout, mas renderiza como se o repositório estivesse no HOME do amigo.
const read = defaultReader(jarvisPaths({ HOME: '/tmp' }, repo));
const renderAgent = (label: TemplateAgent, c: PlistContext, r = read) => render(label, c, r);
const paths = jarvisPaths({ HOME: '/Users/amigo' }, '/Users/amigo/code/jarvis');
const ctx = { paths, bun: '/Users/amigo/.bun/bin/bun', config: DEFAULT_CONFIG };

const lint = (xml: string) => {
	const f = join(mkdtempSync(join(tmpdir(), 'jarvis-plist-')), 'x.plist');
	writeFileSync(f, xml);
	return spawnSync('/usr/bin/plutil', ['-lint', f], { encoding: 'utf8' });
};

describe.each(TEMPLATE_AGENTS)('%s', (label) => {
	const xml = renderAgent(label, ctx);

	test('não sobra marcador e nada aponta para outro usuário', () => {
		expect(xml).not.toMatch(/@[A-Z_]+@/);
		expect(xml).not.toContain('fernandodudata');
		expect(xml).toContain(`<string>${label}</string>`);
	});

	test('os caminhos são os do HOME de quem instala', () => {
		expect(xml).toContain('/Users/amigo/.local/share/jarvis');
	});

	test.runIf(process.platform === 'darwin')('plutil -lint aceita', () => {
		expect(lint(xml).status).toBe(0);
	});
});

test('dev.jarvis.tts sai com a voz pf_dora e a velocidade 1.15', () => {
	const xml = renderAgent('dev.jarvis.tts', ctx);
	expect(xml).toContain('<key>JARVIS_TTS_VOICE</key><string>pf_dora</string>');
	expect(xml).toContain('<key>JARVIS_TTS_SPEED</key><string>1.15</string>');
	expect(xml).toContain('/Users/amigo/.local/share/jarvis/tts/.venv/bin/python');
});

test('a velocidade escolhida no onboarding vai para o plist da voz', () => {
	const cfg = normalizeConfig({ modo: 'completo', modulos: { voz: true }, voz: { voice: 'pm_alex', speed: 1.3 } });
	const xml = renderAgent('dev.jarvis.tts', { ...ctx, config: cfg });
	expect(xml).toContain('<key>JARVIS_TTS_SPEED</key><string>1.3</string>');
	expect(xml).toContain('<string>pm_alex</string>');
});

test('dev.jarvis.callback usa o Bun e o repositório desta máquina', () => {
	const xml = renderAgent('dev.jarvis.callback', ctx);
	expect(xml).toContain('<string>/Users/amigo/.bun/bin/bun</string>');
	expect(xml).toContain('/Users/amigo/code/jarvis/apps/mcp/src/callback-main.ts');
	expect(xml).toContain('<key>JARVIS_CALLBACK_PORT</key><string>7348</string>');
});

test('caminhos com & e < são escapados para XML', () => {
	const odd = jarvisPaths({ HOME: '/Users/a&b<c' }, '/r');
	const xml = renderAgent('dev.jarvis.tts', { ...ctx, paths: odd }, () => '<string>@TTS_HOME@</string>@AI_VOICE_TTS_VOICE@');
	expect(xml).toContain('/Users/a&amp;b&lt;c/.local/share/jarvis/tts');
});

test('marcador sem valor é erro, não plist quebrado', () => {
	expect(() => renderTemplate('<string>@NAO_EXISTE@</string>', {})).toThrow(/NAO_EXISTE/);
});
