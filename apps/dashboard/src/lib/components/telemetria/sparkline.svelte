<script lang="ts">
	import type { Ponto } from '#lib/telemetria/model.js';

	/**
	 * One series, no axes: the recent CPU of an agent. Ink line, recessive baseline, a dot on the latest value.
	 * The title carries the range so the shape is never the only reading.
	 */
	let { pontos, rotulo }: { pontos: ReadonlyArray<Ponto>; rotulo: string } = $props();

	const W = 96;
	const H = 24;
	const PAD = 3;

	const valores = $derived(pontos.flatMap((p) => (p.cpu === null ? [] : [{ t: p.t, v: p.cpu }])));
	const geometria = $derived.by(() => {
		if (valores.length < 2) return null;
		const t0 = valores[0].t;
		const t1 = valores.at(-1)!.t;
		const max = Math.max(5, ...valores.map((p) => p.v));
		const x = (t: number) => PAD + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD * 2);
		const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);
		const d = valores.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
		const last = valores.at(-1)!;
		return { d, cx: x(last.t), cy: y(last.v), max, min: Math.min(...valores.map((p) => p.v)), minutos: Math.max(1, Math.round((t1 - t0) / 60_000)) };
	});
	const fmt = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
</script>

{#if geometria}
	<svg
		viewBox="0 0 {W} {H}"
		width={W}
		height={H}
		class="shrink-0 overflow-visible"
		role="img"
		aria-label="{rotulo}: CPU entre {fmt.format(geometria.min)}% e {fmt.format(geometria.max)}% nos últimos {geometria.minutos} min"
	>
		<title>CPU nos últimos {geometria.minutos} min: de {fmt.format(geometria.min)}% a {fmt.format(geometria.max)}%</title>
		<line x1={PAD} x2={W - PAD} y1={H - PAD} y2={H - PAD} class="stroke-rule" stroke-width="1" />
		<path d={geometria.d} fill="none" class="stroke-ink-soft" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
		<circle cx={geometria.cx} cy={geometria.cy} r="2.5" class="fill-ink stroke-raised" stroke-width="1.5" />
	</svg>
{:else}
	<span class="inline-block w-24 text-center text-micro text-ink-faint" aria-hidden="true">coletando…</span>
{/if}
