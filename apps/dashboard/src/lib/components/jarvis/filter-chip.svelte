<script lang="ts">
	import type { Snippet } from 'svelte';

	/** A filter that lives in the URL: a link, so a view can be bookmarked and the load reads exactly what is shown. */
	let {
		href,
		current,
		count,
		children
	}: { href: string; current: boolean; count?: number; children: Snippet } = $props();
</script>

<a
	{href}
	aria-current={current ? 'page' : undefined}
	data-sveltekit-reset="false"
	class={[
		'inline-flex h-8 shrink-0 pointer-coarse:h-10 items-center gap-1.5 rounded-full border px-3 text-[0.8125rem] font-medium whitespace-nowrap',
		'transition-[background-color,border-color,color,scale] duration-[var(--dur-fast)] ease-[var(--ease-out)] active:scale-[0.97]',
		current
			? 'border-ink bg-ink text-canvas'
			: 'border-rule-strong bg-raised text-ink-soft hover:border-input hover:text-ink'
	]}
>
	{@render children()}
	{#if count !== undefined}
		<span class={['tabular text-micro font-semibold', current ? 'text-canvas/70' : 'text-ink-faint']}>{count}</span>
	{/if}
</a>
