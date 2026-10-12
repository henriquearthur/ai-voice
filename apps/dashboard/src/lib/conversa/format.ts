const clock = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const clockSeconds = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const longDay = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
const decimal = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const whole = new Intl.NumberFormat('pt-BR');

export const time = (at: number) => clock.format(at);
export const timeWithSeconds = (at: number) => clockSeconds.format(at);

/** 2,7 s · 840 ms under a second. */
export function duration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)} ms`;
	if (ms < 60_000) return `${decimal.format(ms / 1000)} s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
}

export const count = (n: number) => whole.format(n);

/** "agora", "há 40 s", "há 3 min", "há 2 h", or the clock time after a day. */
export function ago(at: number, now: number): string {
	const s = Math.max(0, Math.round((now - at) / 1000));
	if (s < 5) return 'agora';
	if (s < 60) return `há ${s} s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `há ${m} min`;
	const h = Math.floor(m / 60);
	if (h < 24) return `há ${h} h`;
	return `${longDay.format(at)}, ${time(at)}`;
}

const startOfDay = (at: number) => {
	const d = new Date(at);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
};

/** "Hoje", "Ontem" or "segunda-feira, 12 de outubro". */
export function dayLabel(at: number, now: number): string {
	const diff = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
	if (diff === 0) return 'Hoje';
	if (diff === 1) return 'Ontem';
	const label = longDay.format(at);
	return label.charAt(0).toUpperCase() + label.slice(1);
}

export const dayKey = (at: number) => startOfDay(at);
