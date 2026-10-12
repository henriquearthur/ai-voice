<script lang="ts">
	import type { Component, Snippet } from 'svelte';

	/** Um módulo opcional: liga e desliga; ligado, mostra só os campos de que ele precisa. */
	let {
		titulo,
		descricao,
		precisa,
		icon: Icon,
		ligado = $bindable(false),
		children
	}: {
		titulo: string;
		descricao: string;
		precisa: string;
		icon: Component<{ class?: string; weight?: 'regular' | 'bold' | 'fill' | 'duotone' }>;
		ligado: boolean;
		children?: Snippet;
	} = $props();

	const id = $props.id();
</script>

<section
	class={[
		'panel grid content-start gap-3 p-4 transition-[border-color,box-shadow] sm:p-5',
		ligado && 'border-[color-mix(in_oklch,var(--brand)_35%,var(--rule))]'
	]}
	aria-labelledby="{id}-t"
>
	<div class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3">
		<span
			class={[
				'grid size-9 place-items-center rounded-[var(--radius-control)] transition-colors duration-[var(--dur-fast)]',
				ligado ? 'bg-brand-soft text-brand' : 'bg-sunken text-ink-faint'
			]}
		>
			<Icon class="size-[1.125rem]" weight={ligado ? 'fill' : 'regular'} />
		</span>
		<div class="min-w-0">
			<h3 id="{id}-t" class="text-heading font-semibold text-ink">{titulo}</h3>
			<p class="mt-0.5 text-meta text-ink-soft">{descricao}</p>
		</div>
		<button
			type="button"
			role="switch"
			aria-checked={ligado}
			aria-labelledby="{id}-t"
			onclick={() => (ligado = !ligado)}
			class={[
				'relative mt-1 inline-flex h-6 w-10 shrink-0 items-center rounded-full border transition-[background-color,border-color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
				'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
				ligado ? 'border-brand bg-brand' : 'border-rule-strong bg-sunken'
			]}
		>
			<span
				class={[
					'size-[1.125rem] rounded-full bg-raised shadow-sm transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)]',
					ligado ? 'translate-x-[1.0625rem]' : 'translate-x-[0.1875rem]'
				]}
			></span>
		</button>
	</div>
	<p class="text-micro text-ink-faint"><span class="font-semibold text-ink-soft">Precisa de:</span> {precisa}</p>
	{#if ligado && children}
		<div class="grid gap-3 border-t border-rule pt-3">{@render children()}</div>
	{/if}
</section>
