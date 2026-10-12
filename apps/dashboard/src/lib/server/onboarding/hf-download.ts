import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, renameSync, statSync, createWriteStream, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Download de modelos do Hugging Face com retomada e verificação.
 *
 * A lista de arquivos (com tamanho e hash) vem da API de árvore do repositório numa revisão fixa.
 * Cada arquivo baixa para `<arquivo>.part` com `Range: bytes=<já baixado>-`, então um download
 * interrompido continua de onde parou. Ao terminar, confere o tamanho e o hash: SHA-256 do LFS para
 * pesos, e o SHA-1 de blob do git para os arquivos pequenos. Só então renomeia para o nome final.
 * Um arquivo final que já existe com o tamanho certo é pulado (a verificação completa roda de novo
 * se `verifyExisting`).
 */

export type HfEntry = {
	readonly type: 'file' | 'directory';
	readonly path: string;
	readonly size: number;
	/** SHA-1 do blob git. */
	readonly oid: string;
	readonly lfs?: { readonly oid: string; readonly size: number };
};

export type HfSpec = {
	readonly repo: string;
	readonly revision: string;
	readonly dest: string;
	/** Prefixos ou nomes exatos a incluir; `voices/p` pega voices/pf_dora.safetensors etc. */
	readonly include: ReadonlyArray<string>;
};

export const KOKORO_SPEC = (dest: string): HfSpec => ({
	repo: 'mlx-community/Kokoro-82M-bf16',
	// A mesma revisão travada do services/tts/install.sh.
	revision: 'a71e4d38b236d968966a2002c4c895dbd12b1c3c',
	dest,
	include: ['config.json', 'kokoro-v1_0.safetensors', 'voices/p', 'README.md']
});

export const PARAKEET_SPEC = (dest: string): HfSpec => ({
	repo: 'FluidInference/parakeet-tdt-0.6b-v3-coreml',
	revision: 'main',
	dest,
	include: [
		'Encoder.mlmodelc/',
		'Decoder.mlmodelc/',
		'Preprocessor.mlmodelc/',
		'JointDecisionv3.mlmodelc/',
		'config.json',
		'parakeet_v3_vocab.json',
		'parakeet_vocab.json'
	]
});

export const VAD_SPEC = (dest: string): HfSpec => ({
	repo: 'FluidInference/silero-vad-coreml',
	revision: 'main',
	dest,
	include: ['silero-vad-unified-256ms-v6.2.1.mlmodelc/', 'config.json']
});

/** Filtra a árvore pelos prefixos da spec; só arquivos, nunca caminhos que escapam do destino. */
export function selectFiles(tree: ReadonlyArray<HfEntry>, include: ReadonlyArray<string>): HfEntry[] {
	return tree.filter(
		(e) =>
			e.type === 'file' &&
			!e.path.split('/').includes('..') &&
			!e.path.startsWith('/') &&
			include.some((p) => (p.endsWith('/') || !p.includes('.') ? e.path.startsWith(p) : e.path === p))
	);
}

export const expectedSize = (e: HfEntry) => e.lfs?.size ?? e.size;

/** Hash esperado: sha256 do LFS, ou sha1 do blob git ("blob <n>\0" + conteúdo). */
export function expectedHash(e: HfEntry): { algo: 'sha256' | 'sha1-git'; hex: string } {
	return e.lfs ? { algo: 'sha256', hex: e.lfs.oid } : { algo: 'sha1-git', hex: e.oid };
}

export async function hashFile(path: string, algo: 'sha256' | 'sha1-git'): Promise<string> {
	const h = createHash(algo === 'sha256' ? 'sha256' : 'sha1');
	if (algo === 'sha1-git') h.update(`blob ${statSync(path).size}\0`);
	for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
	return h.digest('hex');
}

export type DownloadProgress = {
	readonly arquivo: string;
	readonly baixado: number;
	readonly total: number;
};

export type DownloadOptions = {
	readonly fetch?: typeof fetch;
	readonly log: (line: string) => void;
	readonly progress: (p: DownloadProgress) => void;
	readonly signal?: AbortSignal;
	readonly verifyExisting?: boolean;
	readonly endpoint?: string;
};

const HF = 'https://huggingface.co';

export async function listTree(spec: HfSpec, opts: Pick<DownloadOptions, 'fetch' | 'endpoint' | 'signal'>) {
	const f = opts.fetch ?? fetch;
	const url = `${opts.endpoint ?? HF}/api/models/${spec.repo}/tree/${spec.revision}?recursive=1`;
	const res = await f(url, { signal: opts.signal });
	if (!res.ok) throw new Error(`árvore do ${spec.repo}: HTTP ${res.status}`);
	return (await res.json()) as HfEntry[];
}

export async function downloadModel(spec: HfSpec, opts: DownloadOptions): Promise<{ arquivos: number; bytes: number }> {
	const f = opts.fetch ?? fetch;
	const files = selectFiles(await listTree(spec, opts), spec.include);
	if (files.length === 0) throw new Error(`nenhum arquivo do ${spec.repo} casou com ${spec.include.join(', ')}`);
	const total = files.reduce((n, e) => n + expectedSize(e), 0);
	opts.log(`${spec.repo}@${spec.revision.slice(0, 12)}: ${files.length} arquivos, ${(total / 1e6).toFixed(1)} MB`);
	let done = 0;

	for (const e of files) {
		const target = join(spec.dest, e.path);
		const part = `${target}.part`;
		const want = expectedSize(e);
		const hash = expectedHash(e);
		mkdirSync(dirname(target), { recursive: true });

		if (existsSync(target) && statSync(target).size === want) {
			if (!opts.verifyExisting || (await hashFile(target, hash.algo)) === hash.hex) {
				done += want;
				opts.progress({ arquivo: e.path, baixado: done, total });
				continue;
			}
			opts.log(`${e.path}: hash não confere, baixando de novo`);
			rmSync(target);
		}

		let have = existsSync(part) ? statSync(part).size : 0;
		if (have > want) {
			rmSync(part);
			have = 0;
		}
		if (have > 0) opts.log(`${e.path}: retomando em ${(have / 1e6).toFixed(1)} MB`);
		if (have < want) {
			const url = `${opts.endpoint ?? HF}/${spec.repo}/resolve/${spec.revision}/${e.path.split('/').map(encodeURIComponent).join('/')}`;
			const res = await f(url, { headers: have > 0 ? { Range: `bytes=${have}-` } : {}, signal: opts.signal, redirect: 'follow' });
			if (res.status === 200 && have > 0) {
				// O servidor ignorou o Range: recomeça do zero.
				rmSync(part);
				have = 0;
			} else if (!res.ok) {
				throw new Error(`${e.path}: HTTP ${res.status}`);
			}
			if (!res.body) throw new Error(`${e.path}: resposta sem corpo`);
			const out = createWriteStream(part, { flags: have > 0 ? 'a' : 'w', mode: 0o644 });
			try {
				for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
					if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
					have += chunk.byteLength;
					opts.progress({ arquivo: e.path, baixado: done + have, total });
				}
			} finally {
				await new Promise<void>((r, j) => out.end((err?: Error | null) => (err ? j(err) : r())));
			}
		}

		const size = statSync(part).size;
		if (size !== want) throw new Error(`${e.path}: tamanho ${size}, esperado ${want} (o .part fica para retomar)`);
		const got = await hashFile(part, hash.algo);
		if (got !== hash.hex) {
			rmSync(part);
			throw new Error(`${e.path}: ${hash.algo} ${got.slice(0, 12)}… não confere com ${hash.hex.slice(0, 12)}…`);
		}
		renameSync(part, target);
		done += want;
		opts.progress({ arquivo: e.path, baixado: done, total });
		if (want > 5_000_000) opts.log(`${e.path}: ${(want / 1e6).toFixed(1)} MB, ${hash.algo} ok`);
	}
	opts.log(`${files.length} arquivos verificados em ${spec.dest}`);
	return { arquivos: files.length, bytes: total };
}
