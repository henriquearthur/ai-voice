/**
 * O que a página /agentes sabe de um agente do herdr. Puro e sem I/O: roda no servidor e no
 * navegador, e é onde ficam a lista branca de teclas e a leitura do rodapé do terminal.
 */

/** Ações de um botão, na ordem em que aparecem. O texto livre (steer) tem a sua própria. */
export const ACOES = ['aprovar', 'negar', 'modo', 'interromper', 'steer'] as const;
export type Acao = (typeof ACOES)[number];

export const isAcao = (valor: unknown): valor is Acao => typeof valor === 'string' && (ACOES as readonly string[]).includes(valor);

/** Teclas que o dashboard manda: nada fora desta tabela chega ao `herdr send-keys`. */
export const TECLAS = {
	aprovar: ['enter'],
	negar: ['esc'],
	modo: ['shift+tab'],
	interromper: ['ctrl+c'],
	steer: ['ctrl+enter']
} as const satisfies Record<Acao, readonly string[]>;

export const TECLAS_PERMITIDAS: ReadonlySet<string> = new Set(Object.values(TECLAS).flat());

export const TEXTO_MAX = 2000;
export const CAUDA_LINHAS = 40;

export type EstadoAgente = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export type Modo = 'padrao' | 'aceitar-edicoes' | 'plano' | 'auto' | 'sem-permissao';

export const ROTULO_MODO: Record<Modo, string> = {
	padrao: 'Padrão',
	'aceitar-edicoes': 'Aceitar edições',
	plano: 'Plano',
	auto: 'Auto',
	'sem-permissao': 'Sem permissões'
};

export type AgenteVivo = {
	readonly nome: string;
	readonly pane: string;
	readonly agente: string;
	readonly estado: EstadoAgente;
	readonly bloqueado: boolean;
	readonly titulo: string | null;
	readonly cwd: string | null;
};

export type AgenteCard = AgenteVivo & {
	readonly modo: Modo | null;
	readonly cauda: string;
};

const ESTADOS: readonly EstadoAgente[] = ['idle', 'working', 'blocked', 'done'];

const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** Lê a saída de `herdr agent list`. Entrada fora do formato dá lista vazia, nunca exceção. */
export function parseAgentes(bruto: string): AgenteVivo[] {
	let json: unknown;
	try {
		json = JSON.parse(bruto);
	} catch {
		return [];
	}
	const lista = (json as { result?: { agents?: unknown } } | null)?.result?.agents;
	if (!Array.isArray(lista)) return [];
	const vistos = new Set<string>();
	const saida: AgenteVivo[] = [];
	for (const item of lista as Array<Record<string, unknown>>) {
		const pane = texto(item?.pane_id);
		if (pane === null || vistos.has(pane)) continue;
		vistos.add(pane);
		const status = texto(item.agent_status);
		const estado = ESTADOS.find((e) => e === status) ?? 'unknown';
		saida.push({
			nome: texto(item.name) ?? pane,
			pane,
			agente: texto(item.agent) ?? 'agente',
			estado,
			bloqueado: estado === 'blocked',
			titulo: texto(item.terminal_title_stripped) ?? texto(item.terminal_title),
			cwd: texto(item.cwd)
		});
	}
	return saida;
}

const MODOS: ReadonlyArray<readonly [RegExp, Modo]> = [
	[/accept edits on/i, 'aceitar-edicoes'],
	[/plan mode on/i, 'plano'],
	[/auto mode on/i, 'auto'],
	[/bypass permissions on/i, 'sem-permissao']
];

/**
 * O modo de permissão atual, lido do rodapé do Claude Code ("⏵⏵ accept edits on (shift+tab to cycle)").
 * Só as últimas linhas contam; sem nenhuma pista de rodapé devolve null (não é um agente que cicla modos).
 */
export function parseModo(cauda: string): Modo | null {
	const rodape = cauda.split('\n').filter((l) => l.trim() !== '').slice(-8);
	for (let i = rodape.length - 1; i >= 0; i--) {
		const linha = rodape[i]!;
		for (const [regex, modo] of MODOS) if (regex.test(linha)) return modo;
		if (/\? for shortcuts|shift\+tab to cycle/i.test(linha)) return 'padrao';
	}
	return null;
}

/** Uma linha de status com ANSI ou controle não deve chegar à tela; tira o que não é texto. */
export function limparTerminal(bruto: string): string {
	return bruto
		// eslint-disable-next-line no-control-regex
		.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

export type TextoValido = { ok: true; texto: string } | { ok: false; motivo: string };

/** Texto do steer: não vazio, até TEXTO_MAX, sem caracteres de controle além de quebra de linha e tab. */
export function validarTexto(entrada: unknown): TextoValido {
	if (typeof entrada !== 'string') return { ok: false, motivo: 'Escreva o texto a enviar.' };
	const texto = entrada.trim();
	if (texto === '') return { ok: false, motivo: 'Escreva o texto a enviar.' };
	if (texto.length > TEXTO_MAX) return { ok: false, motivo: `O texto passa de ${TEXTO_MAX} caracteres.` };
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(texto)) return { ok: false, motivo: 'O texto tem caracteres de controle.' };
	return { ok: true, texto };
}
