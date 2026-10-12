import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadModel, hashFile, selectFiles, type HfEntry } from '#lib/server/onboarding/hf-download.js';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const gitSha1 = (b: Buffer) => createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');

const big = Buffer.alloc(200_000, 7);
const small = Buffer.from('{"ok":true}\n');
const tree: HfEntry[] = [
	{ type: 'directory', path: 'Encoder.mlmodelc', size: 0, oid: 'x' },
	{ type: 'file', path: 'Encoder.mlmodelc/weights/weight.bin', size: 134, oid: 'lfsptr', lfs: { oid: sha256(big), size: big.length } },
	{ type: 'file', path: 'config.json', size: small.length, oid: gitSha1(small) },
	{ type: 'file', path: 'Encoder_v2.mlmodelc/x.bin', size: 1, oid: 'y' },
	{ type: 'file', path: '../fora.txt', size: 1, oid: 'z' }
];

/** Um Hugging Face falso: serve a árvore e os arquivos, respeitando Range; conta os bytes servidos. */
function fakeHub(opts: { corrupt?: boolean; cutAfter?: number } = {}) {
	const served = { bytes: 0, ranges: [] as string[] };
	const body: Record<string, Buffer> = {
		'Encoder.mlmodelc/weights/weight.bin': opts.corrupt ? Buffer.alloc(big.length, 8) : big,
		'config.json': small
	};
	const f = (async (url: string, init?: RequestInit) => {
		if (url.includes('/api/models/')) return new Response(JSON.stringify(tree));
		const path = decodeURIComponent(url.split('/resolve/main/')[1]!);
		const full = body[path]!;
		const range = (init?.headers as Record<string, string> | undefined)?.Range;
		if (range) served.ranges.push(range);
		const start = range ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
		let chunk = full.subarray(start);
		if (opts.cutAfter !== undefined && path.endsWith('.bin')) {
			// Simula a conexão caindo no meio: entrega só um pedaço e encerra o corpo.
			chunk = chunk.subarray(0, opts.cutAfter);
		}
		served.bytes += chunk.length;
		return new Response(chunk, { status: range ? 206 : 200 });
	}) as unknown as typeof fetch;
	return { f, served };
}

const spec = (dest: string) => ({ repo: 'org/model', revision: 'main', dest, include: ['Encoder.mlmodelc/', 'config.json'] });
const noop = { log: () => {}, progress: () => {} };

test('selectFiles pega prefixos e nomes exatos, nunca diretórios nem caminhos que escapam', () => {
	expect(selectFiles(tree, ['Encoder.mlmodelc/', 'config.json']).map((e) => e.path)).toEqual([
		'Encoder.mlmodelc/weights/weight.bin',
		'config.json'
	]);
	expect(selectFiles(tree, ['voices/p'])).toEqual([]);
	expect(selectFiles(tree, ['..']).map((e) => e.path)).toEqual([]);
});

test.runIf(spawnSync('git', ['--version']).status === 0)('o SHA-1 de blob confere com git hash-object', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'jarvis-hf-'));
	const f = join(dir, 'a.json');
	writeFileSync(f, small);
	const git = spawnSync('git', ['hash-object', f], { encoding: 'utf8' }).stdout.trim();
	expect(await hashFile(f, 'sha1-git')).toBe(git);
});

describe('downloadModel', () => {
	test('baixa, verifica o hash e grava nos caminhos finais', async () => {
		const dest = mkdtempSync(join(tmpdir(), 'jarvis-hf-'));
		const hub = fakeHub();
		const progress: number[] = [];
		const r = await downloadModel(spec(dest), { ...noop, fetch: hub.f, progress: (p) => progress.push(p.baixado / p.total) });
		expect(r.arquivos).toBe(2);
		expect(readFileSync(join(dest, 'Encoder.mlmodelc/weights/weight.bin')).equals(big)).toBe(true);
		expect(readFileSync(join(dest, 'config.json')).equals(small)).toBe(true);
		expect(progress.at(-1)).toBe(1);
	});

	test('retoma do .part com Range, sem baixar de novo o que já tinha', async () => {
		const dest = mkdtempSync(join(tmpdir(), 'jarvis-hf-'));
		const part = join(dest, 'Encoder.mlmodelc/weights/weight.bin.part');
		mkdirSync(join(dest, 'Encoder.mlmodelc/weights'), { recursive: true });
		writeFileSync(part, big.subarray(0, 150_000));
		const hub = fakeHub();
		await downloadModel(spec(dest), { ...noop, fetch: hub.f });
		expect(hub.served.ranges).toEqual(['bytes=150000-']);
		expect(hub.served.bytes).toBe(50_000 + small.length);
		expect(existsSync(part)).toBe(false);
		expect(readFileSync(join(dest, 'Encoder.mlmodelc/weights/weight.bin')).equals(big)).toBe(true);
	});

	test('conexão que cai deixa o .part para a próxima tentativa, que completa', async () => {
		const dest = mkdtempSync(join(tmpdir(), 'jarvis-hf-'));
		await expect(downloadModel(spec(dest), { ...noop, fetch: fakeHub({ cutAfter: 80_000 }).f })).rejects.toThrow(/tamanho/);
		expect(existsSync(join(dest, 'Encoder.mlmodelc/weights/weight.bin.part'))).toBe(true);
		const hub = fakeHub();
		await downloadModel(spec(dest), { ...noop, fetch: hub.f });
		expect(hub.served.ranges).toEqual(['bytes=80000-']);
		expect(readFileSync(join(dest, 'Encoder.mlmodelc/weights/weight.bin')).equals(big)).toBe(true);
	});

	test('hash que não confere é erro e o arquivo não fica no lugar final', async () => {
		const dest = mkdtempSync(join(tmpdir(), 'jarvis-hf-'));
		await expect(downloadModel(spec(dest), { ...noop, fetch: fakeHub({ corrupt: true }).f })).rejects.toThrow(/sha256/);
		expect(existsSync(join(dest, 'Encoder.mlmodelc/weights/weight.bin'))).toBe(false);
	});

	test('arquivo final já presente com o tamanho certo é pulado', async () => {
		const dest = mkdtempSync(join(tmpdir(), 'jarvis-hf-'));
		await downloadModel(spec(dest), { ...noop, fetch: fakeHub().f });
		const hub = fakeHub();
		await downloadModel(spec(dest), { ...noop, fetch: hub.f, verifyExisting: true });
		expect(hub.served.bytes).toBe(0);
	});
});
