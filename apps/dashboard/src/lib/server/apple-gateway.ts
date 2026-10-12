import type { AutomationError } from '@jarvis/apple';
import { Cause, type Effect, Exit, Option } from 'effect';
import type { AppleFailure, AppleOutcome } from '#lib/apple/failure.js';
import { type AppleServices, appleRuntime } from './apple-runtime.js';

// Must track the hint written by @jarvis/apple's Osascript for -1743/-1744.
const PERMISSION_DENIED = /denied Automation permission/i;
const TIMED_OUT = /did not finish within/i;

const CALENDAR_ACCESS =
	'Em Ajustes do Sistema › Privacidade e Segurança › Calendários, dê Acesso Total a “calendar-events” e tente de novo.';

// @jarvis/apple writes its errors in English; the page only shows Portuguese. Each entry must track the
// message written by the package (Calendar: calendar.ts and calendar-helper.ts).
const TRANSLATIONS: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]> = [
	[/Add Events Only/i, () => `O macOS deu ao Jarvis só o acesso “Somente Adicionar Eventos” ao Calendário. ${CALENDAR_ACCESS}`],
	[/denied Calendar access/i, () => `O macOS negou ao Jarvis o acesso ao Calendário. ${CALENDAR_ACCESS}`],
	[/Calendar access request was not answered/i, () => `O pedido de acesso ao Calendário ficou sem resposta. ${CALENDAR_ACCESS}`],
	[/^Calendar not found: (.*)$/s, ([, name]) => `Calendário não encontrado: ${name}`],
	[
		/Calendar helper sources are missing/i,
		() =>
			'O leitor do Calendário não está instalado neste Mac. Rode apps/dashboard/scripts/install-launchagent.sh (ou bun run build:native em packages/apple) e tente de novo.'
	],
	[
		/Could not build the Calendar helper/i,
		() => 'Não deu para compilar o leitor do Calendário. Ele precisa das Command Line Tools do Xcode (xcode-select --install).'
	],
	[/Could not (install the Calendar helper|create .*jarvis)/i, () => 'Não deu para instalar o leitor do Calendário em ~/.local/share/jarvis/bin.'],
	[/Could not run Calendar helper/i, () => 'Não deu para abrir o leitor do Calendário.'],
	[/Unexpected Calendar output/i, () => 'O Calendário respondeu num formato inesperado.'],
	[/Calendar helper/i, () => 'O leitor do Calendário falhou.']
];

/** The Portuguese text for an @jarvis/apple message; anything not listed gets a generic one (details go to the log). */
const translate = (message: string): string => {
	for (const [pattern, render] of TRANSLATIONS) {
		const match = pattern.exec(message);
		if (match !== null) return render(match);
	}
	return 'O app não aceitou o pedido. Os detalhes estão no log do servidor.';
};

const toFailure = (cause: Cause.Cause<unknown>): AppleFailure => {
	const error = Cause.findErrorOption(cause);
	if (Option.isSome(error) && isAutomationError(error.value)) {
		const { message } = error.value;
		if (PERMISSION_DENIED.test(message)) {
			return { kind: 'permission', message: 'O macOS negou ao Jarvis a permissão de Automação para este app.' };
		}
		if (TIMED_OUT.test(message)) {
			return {
				kind: 'timeout',
				message: 'O app não respondeu a tempo. Se o macOS mostrou um pedido de permissão, responda e tente de novo.'
			};
		}
		console.error(`[apple] ${message}`);
		return { kind: 'automation', message: translate(message) };
	}
	console.error(Cause.pretty(cause));
	return { kind: 'unexpected', message: 'Algo falhou no servidor. Veja o terminal do dashboard.' };
};

const isAutomationError = (value: unknown): value is AutomationError =>
	typeof value === 'object' && value !== null && '_tag' in value && value._tag === 'AutomationError';

/** Runs an effect against the macOS apps and returns a result that is safe to hand to the page. */
export const runApple = async <A>(
	effect: Effect.Effect<A, AutomationError, AppleServices>
): Promise<AppleOutcome<A>> => {
	const exit = await appleRuntime.runPromiseExit(effect);
	return Exit.isSuccess(exit) ? { ok: true, value: exit.value } : { ok: false, failure: toFailure(exit.cause) };
};
