<script lang="ts">
	import CheckCircle from 'phosphor-svelte/lib/CheckCircle';
	import Circle from 'phosphor-svelte/lib/Circle';
	import CircleNotch from 'phosphor-svelte/lib/CircleNotch';
	import MinusCircle from 'phosphor-svelte/lib/MinusCircle';
	import WarningCircle from 'phosphor-svelte/lib/WarningCircle';
	import { Button } from '#lib/components/ui/button/index.js';
	import type { CheckItem, JobView } from '#lib/onboarding/model.js';

	/** Uma linha do checklist: o que a detecção achou, o botão da ação e, com tarefa, progresso e log. */
	let {
		item,
		job,
		opcional = false,
		onacao,
		oncancelar
	}: {
		item: CheckItem;
		job?: JobView;
		opcional?: boolean;
		onacao: (id: string) => void;
		oncancelar: (id: string) => void;
	} = $props();

	const rodando = $derived(job?.estado === 'rodando');
	const pct = $derived(job?.progresso == null ? null : Math.round(job.progresso * 100));
	let logAberto = $state(false);
	$effect(() => {
		if (job?.estado === 'erro') logAberto = true;
	});
</script>

<li class={['grid gap-3 px-4 py-3.5 sm:px-5', opcional && item.status !== 'ok' && 'opacity-75']}>
	<div class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3">
		<span class="mt-0.5" aria-hidden="true">
			{#if rodando}
				<CircleNotch class="size-[1.125rem] animate-spin text-brand" weight="bold" />
			{:else if item.status === 'ok'}
				<CheckCircle class="size-[1.125rem] text-positive" weight="fill" />
			{:else if item.status === 'nao-se-aplica'}
				<MinusCircle class="size-[1.125rem] text-ink-faint" />
			{:else if job?.estado === 'erro' || item.status === 'parcial'}
				<WarningCircle class="size-[1.125rem] text-caution" weight="fill" />
			{:else}
				<Circle class="size-[1.125rem] text-ink-faint" />
			{/if}
		</span>
		<div class="min-w-0">
			<p class="flex flex-wrap items-baseline gap-x-2 text-[0.9375rem] font-medium text-ink">
				{item.titulo}
				{#if item.essencial}
					<span class="text-micro font-semibold tracking-wide text-ink-faint uppercase">essencial</span>
				{:else if opcional}
					<span class="text-micro font-semibold tracking-wide text-ink-faint uppercase">opcional</span>
				{/if}
			</p>
			<p class="mt-0.5 truncate font-mono text-[0.75rem] text-ink-soft" title={item.detalhe}>
				<span class="sr-only">{item.status === 'ok' ? 'Pronto: ' : item.status === 'falta' ? 'Falta: ' : ''}</span>
				{rodando && job ? job.etapa : item.detalhe}
			</p>
		</div>
		<div class="flex items-center gap-1.5">
			{#if rodando}
				<Button variant="ghost" size="sm" onclick={() => oncancelar(item.id)}>Cancelar</Button>
			{:else if item.acao}
				<Button variant={opcional ? 'outline' : 'brand'} size="sm" onclick={() => onacao(item.id)}>
					{job?.estado === 'erro' ? 'Tentar de novo' : item.acao}
				</Button>
			{/if}
		</div>
	</div>

	{#if job}
		<div class="grid gap-2 sm:pl-[1.875rem]">
			{#if rodando}
				<div
					class="h-1.5 overflow-hidden rounded-full bg-sunken"
					role="progressbar"
					aria-label={`Progresso: ${item.titulo}`}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={pct ?? undefined}
				>
					{#if pct === null}
						<div class="h-full w-1/3 animate-[indeterminado_1.4s_var(--ease-in-out)_infinite] rounded-full bg-brand"></div>
					{:else}
						<div
							class="h-full rounded-full bg-brand transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-out)]"
							style:width="{pct}%"
						></div>
					{/if}
				</div>
			{/if}
			<button
				type="button"
				class="w-fit text-meta font-medium text-ink-soft hover:text-ink"
				aria-expanded={logAberto}
				onclick={() => (logAberto = !logAberto)}
			>
				{logAberto ? 'Esconder o log' : 'Ver o log'}
				{#if pct !== null && rodando}<span class="tabular text-ink-faint"> · {pct}%</span>{/if}
				{#if job.estado === 'ok'}<span class="text-positive"> · concluído</span>{/if}
				{#if job.estado === 'erro'}<span class="text-alert"> · falhou</span>{/if}
			</button>
			{#if logAberto}
				<pre
					class="well max-h-56 overflow-auto px-3 py-2.5 font-mono text-[0.71875rem] leading-relaxed whitespace-pre-wrap text-ink-soft"
					aria-live="polite">{job.log.join('\n') || '…'}</pre>
			{/if}
		</div>
	{/if}
</li>

<style>
	@keyframes -global-indeterminado {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(300%);
		}
	}
</style>
