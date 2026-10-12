import { join } from 'node:path';
import type { CheckItem, CheckStatus, MicDevice } from '#lib/onboarding/model.js';
import type { JarvisPaths } from './paths.js';

/**
 * O que a detecção precisa do sistema. A implementação real (realProbe) roda comandos e olha o disco;
 * os testes passam uma falsa.
 */
export type Probe = {
	/** Caminho do executável no PATH ou nos lugares usuais de instalação; null se não existe. */
	which(name: string): string | null;
	exists(path: string): boolean;
	/** Tamanho do arquivo em bytes; 0 se não existe. */
	size(path: string): number;
	/** Roda e devolve código e stdout+stderr (com timeout curto). */
	run(cmd: string, args: ReadonlyArray<string>): { code: number; out: string };
	readonly arch: string;
	readonly macosMajor: number;
	readonly uid: number;
};

const firstLine = (s: string) => s.trim().split('\n')[0]?.trim() ?? '';

/** Arquivos que a Escuta (FluidAudio) carrega do Parakeet TDT v3 e da VAD Silero. */
export const PARAKEET_DIR = 'parakeet-tdt-0.6b-v3';
export const PARAKEET_FILES = [
	'Encoder.mlmodelc/coremldata.bin',
	'Decoder.mlmodelc/coremldata.bin',
	'Preprocessor.mlmodelc/coremldata.bin',
	'JointDecisionv3.mlmodelc/coremldata.bin',
	'parakeet_v3_vocab.json'
];
export const VAD_DIR = 'silero-vad';
export const VAD_FILES = ['silero-vad-unified-256ms-v6.2.1.mlmodelc/coremldata.bin'];

/** O Kokoro baixado: pesos (~327 MB) e a voz pf_dora. */
export const KOKORO_WEIGHTS = 'kokoro-v1_0.safetensors';
export const KOKORO_MIN_BYTES = 300_000_000;

function version(p: Probe, bin: string | null, args: string[] = ['--version']): string {
	if (!bin) return '';
	const r = p.run(bin, args);
	return r.code === 0 ? firstLine(r.out) : '';
}

export function launchdLoaded(p: Probe, label: string): boolean {
	return p.run('/bin/launchctl', ['print', `gui/${p.uid}/${label}`]).code === 0;
}

function agentItem(
	p: Probe,
	paths: JarvisPaths,
	label: string,
	titulo: string,
	extra: Partial<CheckItem>
): CheckItem {
	const plist = join(paths.launchAgents, `${label}.plist`);
	const has = p.exists(plist);
	const loaded = has && launchdLoaded(p, label);
	const status: CheckStatus = has && loaded ? 'ok' : has ? 'parcial' : 'falta';
	return {
		id: label,
		grupo: 'servicos',
		titulo,
		status,
		detalhe: loaded ? `no ar · ${plist}` : has ? `gravado, mas não carregado no launchd` : 'não instalado',
		acao: status === 'ok' ? undefined : has ? 'Carregar' : 'Instalar',
		...extra
	};
}

export function detectAll(p: Probe, paths: JarvisPaths): CheckItem[] {
	const itens: CheckItem[] = [];

	// ---------------------------------------------------------------- dependências
	const bun = p.which('bun');
	itens.push({
		id: 'bun',
		grupo: 'dependencias',
		titulo: 'Bun',
		status: bun ? 'ok' : 'falta',
		detalhe: bun ? `${version(p, bun)} · ${bun}` : 'roda o dashboard, o MCP e o maestro',
		acao: bun ? undefined : 'Instalar',
		essencial: true
	});

	const claude = p.which('claude');
	itens.push({
		id: 'claude',
		grupo: 'dependencias',
		titulo: 'Claude Code',
		status: claude ? 'ok' : 'falta',
		detalhe: claude ? `${version(p, claude)} · ${claude}` : 'os agentes e o MCP do Jarvis rodam nele',
		acao: claude ? undefined : 'Instalar',
		essencial: true
	});

	const clt = p.run('/usr/bin/xcode-select', ['-p']);
	itens.push({
		id: 'xcode',
		grupo: 'dependencias',
		titulo: 'Xcode Command Line Tools',
		status: clt.code === 0 ? 'ok' : 'falta',
		detalhe: clt.code === 0 ? firstLine(clt.out) : 'compila a Escuta e o helper do Calendário',
		acao: clt.code === 0 ? undefined : 'Instalar',
		modulos: ['escuta', 'apple']
	});

	const uv = p.which('uv');
	const py312 = p.which('python3.12');
	const pyOk = Boolean(uv || py312);
	itens.push({
		id: 'python',
		grupo: 'dependencias',
		titulo: 'Python 3.12 (uv)',
		status: p.arch !== 'arm64' ? 'nao-se-aplica' : pyOk ? 'ok' : 'falta',
		detalhe:
			p.arch !== 'arm64'
				? 'a voz Kokoro só roda em Apple Silicon; a fala usa o say do macOS'
				: uv
					? `${version(p, uv)} · ${uv}`
					: py312
						? `${version(p, py312)} · ${py312}`
						: 'o servidor de voz Kokoro roda num venv Python 3.12',
		acao: pyOk || p.arch !== 'arm64' ? undefined : 'Instalar',
		modulos: ['voz']
	});

	const herdr = p.which('herdr');
	itens.push({
		id: 'herdr',
		grupo: 'dependencias',
		titulo: 'herdr',
		status: herdr ? 'ok' : 'falta',
		detalhe: herdr ? `${version(p, herdr)} · ${herdr}` : 'os agentes rodam em panes do herdr; a Escuta entrega os pedidos a eles',
		acao: herdr ? undefined : 'Instalar',
		modulos: ['agentes', 'escuta']
	});

	const tailscale = p.which('tailscale');
	itens.push({
		id: 'tailscale',
		grupo: 'dependencias',
		titulo: 'Tailscale',
		status: tailscale ? 'ok' : 'falta',
		detalhe: tailscale ? `${version(p, tailscale)} · ${tailscale}` : 'abre o Jarvis no iPhone e expõe o callback do Grok Bot',
		acao: tailscale && p.which('brew') ? undefined : p.which('brew') ? 'Instalar' : undefined,
		modulos: ['tailscale', 'grok']
	});

	// ---------------------------------------------------------------- modelos
	const weights = join(paths.kokoroDir, KOKORO_WEIGHTS);
	const wSize = p.size(weights);
	const voice = p.exists(join(paths.kokoroDir, 'voices', 'pf_dora.safetensors'));
	const venv = p.exists(join(paths.ttsHome, '.venv', 'bin', 'python'));
	const kokoroModel = wSize >= KOKORO_MIN_BYTES && voice;
	itens.push({
		id: 'kokoro',
		grupo: 'modelos',
		titulo: 'Kokoro TTS · voz pf_dora',
		status: p.arch !== 'arm64' ? 'nao-se-aplica' : kokoroModel && venv ? 'ok' : kokoroModel || venv ? 'parcial' : 'falta',
		detalhe: kokoroModel
			? `${(wSize / 1e6).toFixed(0)} MB em ${paths.kokoroDir}${venv ? '' : ' · falta o venv'}`
			: '~330 MB, só as vozes pt-BR',
		acao: p.arch === 'arm64' && !(kokoroModel && venv) ? 'Baixar' : undefined,
		modulos: ['voz']
	});

	const pk = join(paths.fluidModels, PARAKEET_DIR);
	const vad = join(paths.fluidModels, VAD_DIR);
	const pkOk = PARAKEET_FILES.every((f) => p.exists(join(pk, f)));
	const vadOk = VAD_FILES.every((f) => p.exists(join(vad, f)));
	itens.push({
		id: 'parakeet',
		grupo: 'modelos',
		titulo: 'Parakeet TDT v3 + VAD Silero',
		status: pkOk && vadOk ? 'ok' : pkOk || vadOk ? 'parcial' : 'falta',
		detalhe: pkOk && vadOk ? pk : '~470 MB, reconhecimento de fala local da Escuta',
		acao: pkOk && vadOk ? undefined : 'Baixar',
		modulos: ['escuta']
	});

	// ---------------------------------------------------------------- serviços
	itens.push(agentItem(p, paths, 'dev.jarvis.dashboard', 'Dashboard (dev.jarvis.dashboard)', { essencial: true }));
	itens.push(agentItem(p, paths, 'dev.jarvis.tts', 'Servidor de voz (dev.jarvis.tts)', { modulos: ['voz'] }));
	itens.push(
		agentItem(p, paths, 'dev.jarvis.escuta', 'Escuta (dev.jarvis.escuta)', {
			modulos: ['escuta'],
			...(p.macosMajor < 26 ? { status: 'nao-se-aplica', detalhe: 'precisa do macOS 26', acao: undefined } : {})
		})
	);
	itens.push(agentItem(p, paths, 'dev.jarvis.callback', 'Callback do Grok Bot (dev.jarvis.callback)', { modulos: ['grok'] }));

	const mcpStdio = join(paths.localBin, 'jarvis-mcp-stdio');
	const mcp = claude ? p.run(claude, ['mcp', 'get', 'ai-voice']) : { code: 1, out: '' };
	itens.push({
		id: 'mcp',
		grupo: 'servicos',
		titulo: 'MCP ai-voice no Claude Code',
		status: mcp.code === 0 && p.exists(mcpStdio) ? 'ok' : 'falta',
		detalhe: mcp.code === 0 ? 'registrado (escopo user)' : 'dá ao Claude Code as tools de fala, agenda e lembretes',
		acao: mcp.code === 0 && p.exists(mcpStdio) ? undefined : claude ? 'Registrar' : undefined,
		modulos: ['voz', 'apple', 'echo', 'agentes']
	});

	itens.push({
		id: 'apple',
		grupo: 'servicos',
		titulo: 'Helper do Calendário e Lembretes',
		status: p.exists(paths.calendarHelper) ? 'ok' : 'falta',
		detalhe: p.exists(paths.calendarHelper)
			? `${paths.calendarHelper} · o macOS pede a permissão no primeiro uso`
			: 'compila o helper Swift que lê o Calendário',
		acao: p.exists(paths.calendarHelper) ? undefined : 'Compilar',
		modulos: ['apple']
	});

	const session = p.exists(paths.amazonSession);
	itens.push({
		id: 'echo-login',
		grupo: 'servicos',
		titulo: 'Sessão da Amazon (Echo)',
		status: session ? 'ok' : 'falta',
		detalhe: session ? 'sessão salva (arquivo 0600 fora do repositório)' : 'login pela página local da Amazon; a senha fica só no navegador',
		acao: session ? undefined : 'Entrar',
		modulos: ['echo']
	});

	return itens;
}

/** Microfones de entrada pelo system_profiler (JSON). */
export function parseMicrophones(json: string): MicDevice[] {
	try {
		const data = JSON.parse(json) as { SPAudioDataType?: Array<{ _items?: Array<Record<string, unknown>> }> };
		const out: MicDevice[] = [];
		for (const group of data.SPAudioDataType ?? []) {
			for (const dev of group._items ?? []) {
				if (!dev.coreaudio_device_input) continue;
				out.push({ nome: typeof dev._name === 'string' ? dev._name : 'sem nome', padrao: dev.coreaudio_default_audio_input_device === 'spaudio_yes' });
			}
		}
		return out;
	} catch {
		return [];
	}
}
