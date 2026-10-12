import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Lado servidor do /quadro. O banco (${JARVIS_DIR:-~/.jarvis}/quadro.db) é do pacote packages/quadro;
 * aqui só se lê (modo somente leitura) e se insere um card novo. Banco inexistente = quadro vazio.
 */

import { ESTADOS, type Estado } from '../../routes/quadro/model.js';

export { ESTADOS, type Estado };

export type Evento = { tipo: string; ator: string | null; texto: string | null; ts: number };
export type Card = {
	id: string;
	titulo: string;
	brief: string;
	kit: string | null;
	estado: Estado;
	dono: string | null;
	leaseAte: number | null;
	criadoPor: string | null;
	verdict: string | null;
	resultado: string | null;
	prioridade: number;
	criadoEm: number;
	atualizadoEm: number;
	eventos: Evento[];
};
export type Mensagem = { de: string; para: string; texto: string; ts: number };
export type Quadro = { existe: boolean; cards: Card[]; mensagens: Mensagem[] };

import { BRIEF_MAX, KIT_MAX, TITULO_MAX } from '../../routes/quadro/model.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export const caminhoDb = () => join(process.env.JARVIS_DIR || join(homedir(), '.jarvis'), 'quadro.db');

/** bun:sqlite sob o bun (produção), node:sqlite no node; o especificador é opaco para o bundler. */
async function abrir(caminho: string, somenteLeitura: boolean): Promise<Db> {
	const bun = 'bun:sqlite';
	const node = 'node:sqlite';
	if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') {
		const { Database } = await import(/* @vite-ignore */ bun);
		return somenteLeitura ? new Database(caminho, { readonly: true }) : new Database(caminho);
	}
	const { DatabaseSync } = await import(/* @vite-ignore */ node);
	return new DatabaseSync(caminho, somenteLeitura ? { readOnly: true } : {});
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
/** Aceita segundos ou milissegundos (o pacote ainda não fixou); abaixo de 1e11 é segundos. */
export const emMs = (v: number | null): number | null => (v === null ? null : v < 1e11 ? v * 1000 : v);
const txt = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const isEstado = (v: unknown): v is Estado => (ESTADOS as readonly string[]).includes(v as string);

export async function lerQuadro(opts: { caminho?: string; limiteMensagens?: number } = {}): Promise<Quadro> {
	const caminho = opts.caminho ?? caminhoDb();
	if (!existsSync(caminho)) return { existe: false, cards: [], mensagens: [] };
	let db: Db;
	try {
		db = await abrir(caminho, true);
	} catch {
		return { existe: false, cards: [], mensagens: [] };
	}
	try {
		const linhas = db.prepare('SELECT * FROM cards ORDER BY prioridade DESC, atualizado_em DESC').all() as Record<string, unknown>[];
		const eventosPor = new Map<string, Evento[]>();
		for (const e of db.prepare('SELECT card_id, tipo, ator, texto, ts FROM eventos ORDER BY ts DESC').all() as Record<string, unknown>[]) {
			const id = String(e.card_id);
			const lista = eventosPor.get(id) ?? [];
			if (lista.length < 30) lista.push({ tipo: String(e.tipo), ator: txt(e.ator), texto: txt(e.texto), ts: emMs(num(e.ts)) ?? 0 });
			eventosPor.set(id, lista);
		}
		const cards: Card[] = linhas.map((r) => ({
			id: String(r.id),
			titulo: String(r.titulo ?? ''),
			brief: String(r.brief ?? ''),
			kit: txt(r.kit),
			estado: isEstado(r.estado) ? r.estado : 'aberto',
			dono: txt(r.dono),
			leaseAte: emMs(num(r.lease_ate)),
			criadoPor: txt(r.criado_por),
			verdict: txt(r.verdict),
			resultado: txt(r.resultado),
			prioridade: num(r.prioridade) ?? 0,
			criadoEm: emMs(num(r.criado_em)) ?? 0,
			atualizadoEm: emMs(num(r.atualizado_em)) ?? 0,
			eventos: eventosPor.get(String(r.id)) ?? []
		}));
		const mensagens = (
			db.prepare('SELECT de, para, texto, ts FROM mensagens ORDER BY ts DESC LIMIT ?').all(opts.limiteMensagens ?? 30) as Record<string, unknown>[]
		).map((m) => ({ de: String(m.de), para: String(m.para), texto: String(m.texto ?? ''), ts: emMs(num(m.ts)) ?? 0 }));
		return { existe: true, cards, mensagens };
	} catch {
		// Esquema ainda não criado pelo pacote: tratar como vazio.
		return { existe: true, cards: [], mensagens: [] };
	} finally {
		db.close();
	}
}

export type NovoPedido = { titulo: string; brief: string; kit: string };

export function validarPedido(dados: FormData): { ok: true; pedido: NovoPedido } | { ok: false; erro: string } {
	const campo = (n: string) => {
		const v = dados.get(n);
		return typeof v === 'string' ? v.trim() : '';
	};
	const pedido = { titulo: campo('titulo'), brief: campo('brief'), kit: campo('kit') };
	if (!pedido.titulo) return { ok: false, erro: 'Dê um título ao pedido.' };
	if (pedido.titulo.length > TITULO_MAX) return { ok: false, erro: `Título passa de ${TITULO_MAX} caracteres.` };
	if (pedido.brief.length > BRIEF_MAX) return { ok: false, erro: `Brief passa de ${BRIEF_MAX} caracteres.` };
	if (pedido.kit.length > KIT_MAX) return { ok: false, erro: `Kit passa de ${KIT_MAX} caracteres.` };
	return { ok: true, pedido };
}

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, titulo TEXT NOT NULL, brief TEXT NOT NULL DEFAULT '', kit TEXT, estado TEXT NOT NULL DEFAULT 'aberto',
  dono TEXT, lease_ate INTEGER, criado_por TEXT, verdict TEXT, resultado TEXT, prioridade INTEGER NOT NULL DEFAULT 0, criado_em INTEGER NOT NULL, atualizado_em INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS eventos (card_id TEXT NOT NULL, tipo TEXT NOT NULL, ator TEXT, texto TEXT, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS mensagens (de TEXT NOT NULL, para TEXT NOT NULL, texto TEXT NOT NULL, ts INTEGER NOT NULL);`;

/** Cria o card "J-<n>" aberto, criado_por="fernando", com o evento 'criado'. */
export async function criarPedido(p: NovoPedido, opts: { caminho?: string; agora?: number } = {}): Promise<string> {
	const caminho = opts.caminho ?? caminhoDb();
	mkdirSync(dirname(caminho), { recursive: true });
	const db = await abrir(caminho, false);
	try {
		db.exec('PRAGMA busy_timeout = 3000');
		db.exec(ESQUEMA);
		const agora = opts.agora ?? Date.now();
		db.exec('BEGIN IMMEDIATE');
		try {
			const ids = db.prepare('SELECT id FROM cards').all() as { id: string }[];
			const n = ids.reduce((m, r) => Math.max(m, Number(/^J-(\d+)$/.exec(r.id)?.[1] ?? 0)), 0) + 1;
			const id = `J-${n}`;
			db.prepare(
				"INSERT INTO cards (id, titulo, brief, kit, estado, criado_por, prioridade, criado_em, atualizado_em) VALUES (?, ?, ?, ?, 'aberto', 'fernando', 0, ?, ?)"
			).run(id, p.titulo, p.brief, p.kit || null, agora, agora);
			db.prepare("INSERT INTO eventos (card_id, tipo, ator, texto, ts) VALUES (?, 'criado', 'fernando', ?, ?)").run(id, p.titulo, agora);
			db.exec('COMMIT');
			return id;
		} catch (e) {
			db.exec('ROLLBACK');
			throw e;
		}
	} finally {
		db.close();
	}
}
