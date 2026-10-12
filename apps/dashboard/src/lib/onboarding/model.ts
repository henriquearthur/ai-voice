/**
 * Onboarding de primeira execução: tipos e padrões compartilhados entre o servidor e a página.
 * Nada aqui toca disco; o servidor (lib/server/onboarding) lê, detecta e grava.
 */

/** Módulos opcionais. Desligados, o Jarvis funciona só com o dashboard e o Claude Code. */
export const MODULE_IDS = ['voz', 'escuta', 'agentes', 'echo', 'grok', 'tailscale', 'apple'] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

export type OnboardingConfig = {
	readonly version: 1;
	/** 'minimo' = só dashboard + Claude Code, nada baixado. 'completo' = o que a pessoa ligou abaixo. */
	readonly modo: 'minimo' | 'completo';
	readonly modulos: Readonly<Record<ModuleId, boolean>>;
	readonly locale: string;
	readonly voz: { readonly voice: string; readonly speed: number };
	readonly escuta: {
		/** Parte do nome do microfone (ESCUTA_MIC); vazio = o padrão da Escuta. */
		readonly mic: string;
		readonly stt: 'apple' | 'parakeet';
		/** Agente do herdr que recebe os pedidos falados (ESCUTA_ORQUESTRADOR). */
		readonly orquestrador: string;
	};
	readonly echo: { readonly amazonPage: string; readonly defaultDevice: string; readonly output: 'mac' | 'echo' };
	readonly callbackPort: number;
	/** ISO da última vez que o onboarding foi concluído; ausente = ainda não terminou. */
	readonly concluidoEm?: string;
};

/** A config editável na página (os campos do tipo são readonly). */
export type DeepMutable<T> = { -readonly [K in keyof T]: T[K] extends object ? DeepMutable<T[K]> : T[K] };

export const DEFAULT_CONFIG: OnboardingConfig = {
	version: 1,
	modo: 'minimo',
	modulos: { voz: false, escuta: false, agentes: false, echo: false, grok: false, tailscale: false, apple: false },
	locale: 'pt-BR',
	voz: { voice: 'pf_dora', speed: 1.15 },
	escuta: { mic: '', stt: 'parakeet', orquestrador: '' },
	echo: { amazonPage: 'amazon.com.br', defaultDevice: '', output: 'mac' },
	callbackPort: 7348
};

export type CheckStatus = 'ok' | 'falta' | 'parcial' | 'nao-se-aplica';

/** Uma linha do checklist: o que foi detectado de verdade e, se faltar, o que o botão faz. */
export type CheckItem = {
	readonly id: string;
	readonly grupo: 'dependencias' | 'modelos' | 'servicos';
	readonly titulo: string;
	readonly status: CheckStatus;
	/** O que a detecção achou: versão, caminho, tamanho. */
	readonly detalhe: string;
	/** Rótulo do botão quando há uma ação ("Instalar", "Baixar", "Gravar"); ausente = sem ação automática. */
	readonly acao?: string;
	/** Módulos que precisam deste item; ausente = nenhum (só o essencial ou opcional). */
	readonly modulos?: ReadonlyArray<ModuleId>;
	/** Obrigatório no modo mínimo. */
	readonly essencial?: boolean;
};

export type JobState = 'rodando' | 'ok' | 'erro';

export type JobView = {
	readonly id: string;
	readonly item: string;
	readonly titulo: string;
	readonly estado: JobState;
	/** 0–1 quando se sabe; null = indeterminado. */
	readonly progresso: number | null;
	readonly etapa: string;
	readonly log: ReadonlyArray<string>;
	readonly iniciadoEm: string;
	readonly terminadoEm?: string;
};

/** Segredos que o onboarding grava no Keychain; a página só vê se existem, nunca o valor. */
export const SECRET_IDS = ['grokbot-webhook-url', 'grokbot-key'] as const;
export type SecretId = (typeof SECRET_IDS)[number];

export const SECRET_SERVICE: Readonly<Record<SecretId, string>> = {
	'grokbot-webhook-url': 'jarvis-grokbot-webhook-url',
	'grokbot-key': 'jarvis-grokbot-key'
};

export type MicDevice = { readonly nome: string; readonly padrao: boolean };

export type OnboardingState = {
	readonly configurado: boolean;
	readonly config: OnboardingConfig;
	readonly itens: ReadonlyArray<CheckItem>;
	readonly jobs: ReadonlyArray<JobView>;
	readonly segredos: Readonly<Record<SecretId, boolean>>;
	readonly microfones: ReadonlyArray<MicDevice>;
	readonly home: string;
};

/** Mescla um objeto parcial (vindo do arquivo ou do formulário) sobre os padrões, descartando o que não vale. */
export function normalizeConfig(input: unknown): OnboardingConfig {
	const o = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
	const str = (v: unknown, d: string, max = 200) =>
		typeof v === 'string' && v.length <= max && !/[\n\r"$`\\]/.test(v) ? v.trim() : d;
	const modulos = { ...DEFAULT_CONFIG.modulos };
	for (const id of MODULE_IDS) if (typeof o.modulos?.[id] === 'boolean') modulos[id] = o.modulos[id];
	const speed = Number(o.voz?.speed);
	const port = Number(o.callbackPort);
	const cfg: OnboardingConfig = {
		version: 1,
		modo: o.modo === 'completo' ? 'completo' : 'minimo',
		modulos,
		locale: str(o.locale, DEFAULT_CONFIG.locale, 20),
		voz: {
			voice: /^[a-z]{2}_[a-z]+$/.test(o.voz?.voice ?? '') ? o.voz.voice : DEFAULT_CONFIG.voz.voice,
			speed: Number.isFinite(speed) && speed >= 0.5 && speed <= 2 ? speed : DEFAULT_CONFIG.voz.speed
		},
		escuta: {
			mic: str(o.escuta?.mic, ''),
			stt: o.escuta?.stt === 'apple' ? 'apple' : 'parakeet',
			orquestrador: str(o.escuta?.orquestrador, '', 80)
		},
		echo: {
			amazonPage: /^amazon\.[a-z.]+$/.test(o.echo?.amazonPage ?? '') ? o.echo.amazonPage : DEFAULT_CONFIG.echo.amazonPage,
			defaultDevice: /^[A-Za-z0-9]{0,40}$/.test(o.echo?.defaultDevice ?? '') ? (o.echo?.defaultDevice ?? '') : '',
			output: o.echo?.output === 'echo' ? 'echo' : 'mac'
		},
		callbackPort: Number.isInteger(port) && port > 1024 && port < 65536 ? port : DEFAULT_CONFIG.callbackPort,
		...(typeof o.concluidoEm === 'string' ? { concluidoEm: o.concluidoEm } : {})
	};
	// Modo mínimo desliga tudo o que baixa ou instala serviço.
	if (cfg.modo === 'minimo') return { ...cfg, modulos: { ...DEFAULT_CONFIG.modulos } };
	return cfg;
}

/** Itens que precisam estar ok para o onboarding dar "pronto", conforme o modo e os módulos ligados. */
export function itensNecessarios(itens: ReadonlyArray<CheckItem>, cfg: OnboardingConfig): CheckItem[] {
	return itens.filter(
		(i) => i.essencial || (cfg.modo === 'completo' && (i.modulos ?? []).some((m) => cfg.modulos[m]))
	);
}
