<script lang="ts">
	import type { Component, Snippet } from 'svelte';

	/**
	 * The top of every module: title, a live one-line summary, actions on the right.
	 * `icon` (optional) repeats the module's nav icon beside the title.
	 */
	let {
		title,
		summary,
		actions,
		icon: Icon
	}: {
		title: string;
		summary?: Snippet;
		actions?: Snippet;
		icon?: Component<{ class?: string; weight?: 'regular' | 'bold' | 'fill' | 'duotone' }>;
	} = $props();
</script>

<header class="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 pb-6 md:pb-8">
	<div class="min-w-0">
		<h1 class="display flex items-center gap-2.5 text-[1.625rem] leading-[1.1] text-ink sm:text-title">
			{#if Icon}
				<Icon class="size-[0.85em] shrink-0 text-brand" weight="fill" />
			{/if}
			{title}
		</h1>
		{#if summary}
			<p class="mt-2 max-w-[65ch] text-body text-ink-soft" aria-live="polite">{@render summary()}</p>
		{/if}
	</div>
	{#if actions}
		<div class="flex flex-wrap items-center gap-2">{@render actions()}</div>
	{/if}
</header>
