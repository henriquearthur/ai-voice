<script lang="ts">
	import CaretRight from 'phosphor-svelte/lib/CaretRight';
	import { ago, count, duration } from '#lib/conversa/format.js';
	import { arvoreSubagentes, SUBAGENTE_ROTULO, type NoSubagente, type Subagente, type SubagenteEstado } from '#lib/telemetria/model.js';

	/**
	 * An agent's subagents as a tree: the ones the agent opened, and under each the ones it opened in turn.
	 * Each level shows what is still going first; the finished ones fold into "N concluídos".
	 * Static on purpose: the page re-renders at most once a second and nothing here animates.
	 */
	let { subagentes, dono, now }: { subagentes: ReadonlyArray<Subagente>; dono: string; now: number } = $props();

	const raizes = $derived(arvoreSubagentes(subagentes));

	const cor: Record<SubagenteEstado, string> = {
		rodando: 'text-brand',
		parado: 'text-caution',
		terminou: 'text-positive'
	};

	const levou = (s: Subagente) => {
		const ms = s.duracaoS !== null ? s.duracaoS * 1000 : s.fim !== null && s.inicio !== null ? s.fim - s.inicio : null;
		return ms === null ? null : duration(ms);
	};
</script>

{#snippet nivel(nos: ReadonlyArray<NoSubagente>, pai: string)}
	{@const ativos = nos.filter((n) => n.ativo)}
	{@const feitos = nos.filter((n) => !n.ativo)}
	<div class="grid gap-1.5 border-l border-rule pl-4">
		{#if ativos.length > 0}
			<ul class="grid gap-1.5">
				{#each ativos as n (n.sub.id)}
					{@render item(n, pai)}
				{/each}
			</ul>
		{/if}
		{#if feitos.length > 0}
			<details class="group relative">
				<summary
					class="relative flex w-fit cursor-pointer list-none items-center gap-1 text-micro font-semibold text-ink-soft before:absolute before:top-1/2 before:-left-4 before:w-3 before:border-t before:border-rule hover:text-ink [&::-webkit-details-marker]:hidden"
				>
					<CaretRight class="size-3 group-open:rotate-90" weight="bold" aria-hidden="true" />
					<span class="tabular">{count(feitos.length)}</span>
					{feitos.length === 1 ? 'concluído' : 'concluídos'}
				</summary>
				<ul class="mt-1.5 grid gap-1.5">
					{#each feitos as n (n.sub.id)}
						{@render item(n, pai)}
					{/each}
				</ul>
			</details>
		{/if}
	</div>
{/snippet}

{#snippet item(n: NoSubagente, pai: string)}
	{@const s = n.sub}
	{@const ativo = s.estado !== 'terminou' && s.fim === null}
	{@const tempo = levou(s)}
	<li class="relative min-w-0 before:absolute before:top-[0.6rem] before:-left-4 before:w-3 before:border-t before:border-rule">
		<p class="flex min-w-0 items-baseline gap-x-2 text-meta">
			<span class={['inline-flex shrink-0 items-center self-center', cor[s.estado]]} title={SUBAGENTE_ROTULO[s.estado]}>
				<span class="status-dot" aria-hidden="true"></span>
				<span class="sr-only">{SUBAGENTE_ROTULO[s.estado]}</span>
			</span>
			<span class={['min-w-0 truncate font-medium', ativo ? 'text-ink' : 'text-ink-soft']}>{s.descricao}</span>
			{#if s.tipo && s.tipo !== s.descricao}<span class="shrink-0 rounded-sm bg-sunken px-1.5 text-micro text-ink-soft">{s.tipo}</span>{/if}
		</p>
		<p class="flex flex-wrap gap-x-2 pl-3.5 text-micro text-ink-faint">
			<span class="truncate">aberto por <span class="text-ink-soft">{s.abertoPor ?? pai}</span></span>
			{#if ativo}
				{#if s.inicio !== null}<span class="tabular">{s.estado === 'parado' ? 'parado, ' : ''}começou {ago(s.inicio, now)}</span>{/if}
				{#if s.estado === 'parado' && s.ultimaAtividadeEm !== null}<span class="tabular">sem atividade {ago(s.ultimaAtividadeEm, now)}</span>{/if}
			{:else if tempo}
				<span class="tabular">levou {tempo}</span>
			{/if}
		</p>
		{#if ativo && s.aguardando}
			<p class="pl-3.5 text-micro font-semibold text-caution">esperando: {s.aguardando}</p>
		{/if}
		{#if !ativo && s.resumoFim}
			<p class="pl-3.5 text-micro text-ink-soft">{s.resumoFim}</p>
		{/if}
		{#if n.filhos.length > 0}
			<div class="mt-1.5 ml-[0.2rem]">
				{@render nivel(n.filhos, s.descricao)}
			</div>
		{/if}
	</li>
{/snippet}

{#if raizes.length > 0}
	{@render nivel(raizes, dono)}
{/if}
