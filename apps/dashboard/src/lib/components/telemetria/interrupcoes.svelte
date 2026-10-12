<script lang="ts">
	import { ago, count, duration, time } from '#lib/conversa/format.js';
	import type { Escuta } from '#lib/telemetria/model.js';

	/** The latest times speech cut Jarvis off, newest first. */
	let { escuta, now }: { escuta: Escuta | null; now: number } = $props();

	const ultimas = $derived((escuta?.interrupcoes ?? []).slice(0, 8));
</script>

<section aria-labelledby="interrupcoes-title" class="sheet">
	<header class="flex items-baseline justify-between gap-4 border-b border-rule px-5 py-3.5">
		<h2 id="interrupcoes-title" class="text-heading font-semibold text-ink">Interrupções</h2>
		{#if escuta}
			<p class="meta tabular">
				{#if escuta.pedidos !== null}{count(escuta.pedidos)} {escuta.pedidos === 1 ? 'pedido' : 'pedidos'}{/if}
				{#if escuta.pedidos !== null && escuta.interrupcoesTotal !== null}·{/if}
				{#if escuta.interrupcoesTotal !== null}{count(escuta.interrupcoesTotal)} {escuta.interrupcoesTotal === 1 ? 'interrupção' : 'interrupções'}{/if}
				{#if escuta.killMs?.p50 != null}· voz para em {duration(escuta.killMs.p50)} (p50){/if}
			</p>
		{/if}
	</header>
	{#if ultimas.length === 0}
		<p class="px-5 py-6 meta">{escuta ? 'Ninguém interrompeu o Jarvis ainda.' : 'O coletor não trouxe dados da escuta.'}</p>
	{:else}
		<ol class="divide-y divide-rule">
			{#each ultimas as i (i.at)}
				<li class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 px-5 py-2.5">
					<time class="tabular text-meta font-medium text-ink" datetime={new Date(i.at).toISOString()} title={ago(i.at, now)}>{time(i.at)}</time>
					<p class="min-w-0 truncate text-meta text-ink-soft">
						{#if i.motivo}<span class="text-ink">{i.motivo}</span>{/if}
						{#if i.motivo && i.texto} · {/if}
						{#if i.texto}“{i.texto}”{/if}
						{#if !i.motivo && !i.texto}{ago(i.at, now)}{/if}
					</p>
					<p class="tabular text-micro text-ink-faint" title="Da interrupção até a voz parar">
						{i.killMs === null ? '' : `parou em ${duration(i.killMs)}`}
					</p>
				</li>
			{/each}
		</ol>
	{/if}
</section>
