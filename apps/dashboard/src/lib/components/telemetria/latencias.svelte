<script lang="ts">
	import { count, duration } from '#lib/conversa/format.js';
	import type { Latencia, Percentis } from '#lib/telemetria/model.js';

	/**
	 * p50 and p95 per path, last hour, from Prometheus. A bar on a shared scale per group shows the spread:
	 * the solid part to p50, the faint part on to p95. Numbers are always written, the bar only helps compare.
	 */
	let { latencias, prometheus, entregaColetor }: { latencias: ReadonlyArray<Latencia>; prometheus: 'ok' | 'fora'; entregaColetor: Percentis | null } =
		$props();

	const grupos = $derived.by(() => {
		const linhas = [...latencias];
		// Without Prometheus, the collector's own delivery percentiles still say something.
		if (entregaColetor && !linhas.some((l) => l.id === 'escuta-entrega' && l.p50 !== null)) {
			const resto = linhas.filter((l) => l.id !== 'escuta-entrega');
			resto.push({ id: 'escuta-entrega', grupo: 'entrega', rotulo: 'Pedido entregue', detalhe: 'da fala ao agente receber (coletor)', p50: entregaColetor.p50, p95: entregaColetor.p95, amostras: entregaColetor.n ?? null });
			linhas.splice(0, linhas.length, ...resto);
		}
		return (['voz', 'entrega'] as const).map((g) => {
			const items = linhas.filter((l) => l.grupo === g);
			const max = Math.max(1, ...items.map((l) => l.p95 ?? l.p50 ?? 0));
			return { g, titulo: g === 'voz' ? 'Voz' : 'Entrega', items, max };
		});
	});
	const vazio = $derived(grupos.every((g) => g.items.every((l) => l.p50 === null)));
</script>

<section aria-labelledby="latencia-title" class="sheet">
	<header class="flex items-baseline justify-between gap-4 border-b border-rule px-5 py-3.5">
		<h2 id="latencia-title" class="text-heading font-semibold text-ink">Latência</h2>
		<p class="meta">p50 · p95, última hora</p>
	</header>
	{#if vazio}
		<p class="px-5 py-6 meta">
			{prometheus === 'fora' ? 'O Prometheus local não respondeu; sem histórico de latência agora.' : 'Sem amostras na última hora.'}
		</p>
	{:else}
		<div class="grid gap-5 px-5 py-4">
			{#each grupos as grupo (grupo.g)}
				{#if grupo.items.some((l) => l.p50 !== null)}
					<div class="grid gap-3">
						<h3 class="field-label">{grupo.titulo}</h3>
						<ul class="grid gap-3">
							{#each grupo.items.filter((l) => l.p50 !== null) as l (l.id)}
								<li class="grid gap-1.5">
									<div class="flex items-baseline justify-between gap-3">
										<p class="min-w-0">
											<span class="text-meta font-semibold text-ink">{l.rotulo}</span>
											<span class="block truncate text-micro text-ink-faint">{l.detalhe}{l.amostras ? ` · ${count(Math.round(l.amostras))} amostras` : ''}</span>
										</p>
										<p class="shrink-0 text-meta tabular">
											<span class="font-semibold text-ink">{duration(l.p50 ?? 0)}</span>
											<span class="text-ink-faint"> · </span>
											<span class="text-ink-soft">{l.p95 === null ? '—' : duration(l.p95)}</span>
										</p>
									</div>
									<div class="relative h-1.5 rounded-full bg-sunken" aria-hidden="true">
										{#if l.p95 !== null}
											<div class="absolute inset-y-0 left-0 rounded-full bg-brand/25" style:width="{Math.min(100, (l.p95 / grupo.max) * 100)}%"></div>
										{/if}
										<div class="absolute inset-y-0 left-0 rounded-full bg-brand" style:width="{Math.min(100, ((l.p50 ?? 0) / grupo.max) * 100)}%"></div>
									</div>
								</li>
							{/each}
						</ul>
					</div>
				{/if}
			{/each}
		</div>
	{/if}
</section>
