import { execFile } from 'node:child_process';
import { access, open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildSnapshot, parseEvents, parseSynth, type ProcessState, type Snapshot } from '#lib/conversa/model.js';

/**
 * The escuta (dev.jarvis.escuta) as the dashboard sees it: its log files, its LaunchAgent and the local
 * voice server. Reads only; the controls go through launchctl with an absolute path and no shell.
 */

const JARVIS = join(homedir(), '.local/share/jarvis');
const EVENTS = join(JARVIS, 'escuta/logs/escuta.events.jsonl');
const VOICE_LOG = join(JARVIS, 'tts/logs/server.err.log');
const LABEL = 'dev.jarvis.escuta';
const PLIST = join(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const LAUNCHCTL = '/bin/launchctl';
const VOICE_HEALTH = 'http://127.0.0.1:7349/health';

const EVENTS_TAIL = 512 * 1024;
const VOICE_TAIL = 256 * 1024;

const uid = () => process.getuid?.() ?? 501;
const service = () => `gui/${uid()}/${LABEL}`;

type Run = { code: number; stdout: string; stderr: string };

function launchctl(args: ReadonlyArray<string>, timeout = 10_000): Promise<Run> {
	return new Promise((resolve) => {
		execFile(LAUNCHCTL, args, { timeout, shell: false, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
			const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
			resolve({ code, stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

/** The last `bytes` of a file as whole lines; a missing file reads as no lines. */
async function tail(path: string, bytes: number): Promise<string[] | null> {
	let handle;
	try {
		handle = await open(path, 'r');
	} catch {
		return null;
	}
	try {
		const { size } = await handle.stat();
		const start = Math.max(0, size - bytes);
		const buffer = Buffer.alloc(size - start);
		await handle.read(buffer, 0, buffer.length, start);
		const lines = buffer.toString('utf8').split('\n');
		if (start > 0) lines.shift();
		return lines;
	} finally {
		await handle.close();
	}
}

export async function readProcess(): Promise<ProcessState> {
	const out = await launchctl(['print', service()], 4000);
	if (out.code !== 0) {
		// 113: "Could not find service" in this domain.
		return { state: /could not find|113/i.test(out.stderr + out.code) ? 'unloaded' : 'unknown', pid: null };
	}
	const state = /^\tstate = (\S+)/m.exec(out.stdout)?.[1];
	const pid = /^\tpid = (\d+)/m.exec(out.stdout)?.[1];
	return { state: state === 'running' ? 'running' : 'stopped', pid: pid ? Number(pid) : null };
}

async function readVoice(): Promise<Snapshot['voice']> {
	try {
		const res = await fetch(VOICE_HEALTH, { signal: AbortSignal.timeout(1500) });
		return res.ok ? 'ok' : 'off';
	} catch {
		return 'off';
	}
}

let processCache: { at: number; value: ProcessState } | null = null;
let voiceCache: { at: number; value: Snapshot['voice'] } | null = null;

async function cachedProcess(maxAge: number) {
	if (!processCache || Date.now() - processCache.at > maxAge) processCache = { at: Date.now(), value: await readProcess() };
	return processCache.value;
}
async function cachedVoice(maxAge: number) {
	if (!voiceCache || Date.now() - voiceCache.at > maxAge) voiceCache = { at: Date.now(), value: await readVoice() };
	return voiceCache.value;
}

export async function readSnapshot(fresh = false): Promise<Snapshot> {
	const [eventLines, voiceLines, proc, voice] = await Promise.all([
		tail(EVENTS, EVENTS_TAIL),
		tail(VOICE_LOG, VOICE_TAIL),
		cachedProcess(fresh ? 0 : 2500),
		cachedVoice(fresh ? 0 : 15_000)
	]);
	return buildSnapshot({
		events: parseEvents(eventLines ?? []),
		synths: parseSynth(voiceLines ?? []),
		process: proc,
		voice,
		installed: eventLines !== null,
		now: Date.now()
	});
}

/* ------------------------------------------------------------------------------------------------ */
/* Live: one watcher for every open page. It looks at the files' size and mtime twice a second and   */
/* only rebuilds (and pushes) when something changed, or when launchd/the voice server changed state. */
/* ------------------------------------------------------------------------------------------------ */

type Listener = (snapshot: Snapshot) => void;
const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | undefined;
let lastSignature = '';
let last: Snapshot | null = null;
let ticking = false;

async function signature() {
	const parts = await Promise.all(
		[EVENTS, VOICE_LOG].map((p) =>
			stat(p).then(
				(s) => `${s.size}:${s.mtimeMs}`,
				() => '-'
			)
		)
	);
	const proc = await cachedProcess(2500);
	const voice = await cachedVoice(15_000);
	return `${parts.join('|')}|${proc.state}:${proc.pid}|${voice}`;
}

async function tick(force = false) {
	if (ticking) return;
	ticking = true;
	try {
		const sig = await signature();
		if (!force && sig === lastSignature && last) return;
		lastSignature = sig;
		last = await readSnapshot();
		for (const listener of listeners) listener(last);
	} catch (error) {
		console.error('[conversa] leitura da escuta falhou', error);
	} finally {
		ticking = false;
	}
}

/** Calls `listener` now and on every change. Returns the unsubscribe function. */
export function watchEscuta(listener: Listener): () => void {
	listeners.add(listener);
	if (last) listener(last);
	else void tick(true);
	timer ??= setInterval(() => void tick(), 500);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0 && timer) {
			clearInterval(timer);
			timer = undefined;
			last = null;
			lastSignature = '';
		}
	};
}

/** After a control: drop the caches so every open page sees the new state right away. */
async function refreshNow() {
	processCache = null;
	await tick(true);
}

import.meta.hot?.dispose(() => {
	if (timer) clearInterval(timer);
	listeners.clear();
});

/* ------------------------------------------------------------------------------------------------ */
/* Controls                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

export type Control = 'pausar' | 'retomar' | 'reiniciar';
export type ControlResult = { readonly ok: true; readonly message: string } | { readonly ok: false; readonly message: string };

let lastControlAt = 0;

async function waitFor(predicate: (p: ProcessState) => boolean, ms: number) {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		const p = await readProcess();
		if (predicate(p)) return true;
		await new Promise((r) => setTimeout(r, 200));
	}
	return false;
}

async function bootstrap(): Promise<ControlResult> {
	try {
		await access(PLIST);
	} catch {
		return {
			ok: false,
			message: 'O LaunchAgent da escuta não está instalado. Rode apps/escuta/scripts/instalar.sh --carregar no Mac.'
		};
	}
	const out = await launchctl(['bootstrap', `gui/${uid()}`, PLIST]);
	if (out.code !== 0) return { ok: false, message: `O launchd não carregou a escuta (código ${out.code}).` };
	await waitFor((p) => p.state === 'running', 5000);
	return { ok: true, message: 'Escuta ligada. Ela abre o microfone em alguns segundos.' };
}

export async function control(action: Control): Promise<ControlResult> {
	if (Date.now() - lastControlAt < 3000) {
		return { ok: false, message: 'Um comando acabou de ser enviado. Espere alguns segundos.' };
	}
	lastControlAt = Date.now();
	try {
		const proc = await readProcess();
		switch (action) {
			case 'pausar': {
				if (proc.state === 'unloaded') return { ok: true, message: 'A escuta já estava desligada.' };
				const out = await launchctl(['bootout', service()]);
				// bootout ends in the background: wait for the job to leave launchd before saying it did.
				const gone = await waitFor((p) => p.state === 'unloaded', 10_000);
				if (out.code !== 0 && !gone) return { ok: false, message: `O launchd não desligou a escuta (código ${out.code}).` };
				return { ok: true, message: 'Escuta pausada. O microfone fechou e o ícone saiu da barra de menus.' };
			}
			case 'retomar': {
				if (proc.state === 'unloaded') return await bootstrap();
				// Loaded: start it if it quit, or restart it to undo a pause made in the menu bar panel.
				const out = await launchctl(['kickstart', '-k', service()]);
				if (out.code !== 0) return { ok: false, message: `O launchd não abriu a escuta (código ${out.code}).` };
				return { ok: true, message: 'Escuta retomada. Ela abre o microfone em alguns segundos.' };
			}
			case 'reiniciar': {
				if (proc.state === 'unloaded') return await bootstrap();
				const out = await launchctl(['kickstart', '-k', service()]);
				if (out.code !== 0) return { ok: false, message: `O launchd não reiniciou a escuta (código ${out.code}).` };
				return { ok: true, message: 'Escuta reiniciada: microfone e reconhecimento abertos do zero.' };
			}
		}
	} finally {
		await refreshNow();
	}
}
