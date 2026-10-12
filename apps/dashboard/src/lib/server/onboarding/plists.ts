import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OnboardingConfig } from '#lib/onboarding/model.js';
import { envValues } from './config.js';
import type { JarvisPaths } from './paths.js';

/**
 * LaunchAgents dev.jarvis.* gerados a partir dos mesmos modelos services/launchd/*.plist.in que o
 * scripts/setup.sh usa, com os @MARCADORES@ trocados pelos caminhos desta máquina. O dashboard e a Escuta
 * têm instaladores próprios (que já usam $HOME) e são instalados rodando esses scripts.
 */
export const TEMPLATE_AGENTS = ['dev.jarvis.tts', 'dev.jarvis.callback'] as const;
export type TemplateAgent = (typeof TEMPLATE_AGENTS)[number];

export const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export type PlistContext = { readonly paths: JarvisPaths; readonly bun: string; readonly config: OnboardingConfig };

export function markerValues({ paths, bun, config }: PlistContext): Record<string, string> {
	return { REPO: paths.repo, BUN: bun, DATA: paths.data, TTS_HOME: paths.ttsHome, ...envValues(config) };
}

/** Troca @CHAVE@ por valores (escapados para XML, por padrão); falha se sobrar marcador sem valor. */
export function renderTemplate(
	template: string,
	values: Record<string, string>,
	escape: (s: string) => string = xmlEscape
): string {
	const out = template.replace(/@([A-Z_]+)@/g, (m, key: string) => (key in values ? escape(values[key]!) : m));
	const left = out.match(/@[A-Z_]+@/);
	if (left) throw new Error(`marcador sem valor: ${left[0]}`);
	return out;
}

/** Ajustes da voz que o modelo não parametriza: a velocidade escolhida no onboarding. */
function tunePlist(label: TemplateAgent, xml: string, cfg: OnboardingConfig): string {
	if (label !== 'dev.jarvis.tts') return xml;
	return xml.replace(
		/(<key>JARVIS_TTS_SPEED<\/key><string>)[^<]*(<\/string>)/,
		`$1${cfg.voz.speed}$2`
	);
}

export function renderAgent(label: TemplateAgent, ctx: PlistContext, readTemplate = defaultReader(ctx.paths)): string {
	return tunePlist(label, renderTemplate(readTemplate(label), markerValues(ctx)), ctx.config);
}

export const defaultReader = (paths: JarvisPaths) => (label: string) =>
	readFileSync(join(paths.repo, 'services', 'launchd', `${label}.plist.in`), 'utf8');

export const agentPath = (paths: JarvisPaths, label: string) => join(paths.launchAgents, `${label}.plist`);
