<script lang="ts">
	import type { Snippet } from 'svelte';
	import Warning from 'phosphor-svelte/lib/Warning';
	import WarningOctagon from 'phosphor-svelte/lib/WarningOctagon';
	import Info from 'phosphor-svelte/lib/Info';
	import CheckCircle from 'phosphor-svelte/lib/CheckCircle';

	type Tone = 'caution' | 'alert' | 'info' | 'positive';

	/** An inline notice: what happened, then (as children) what to do about it. */
	let {
		tone = 'info',
		title,
		children,
		action,
		class: className
	}: { tone?: Tone; title: string; children?: Snippet; action?: Snippet; class?: string } = $props();

	const icons = { caution: Warning, alert: WarningOctagon, info: Info, positive: CheckCircle };
	const Icon = $derived(icons[tone]);
</script>

<div
	role={tone === 'alert' ? 'alert' : 'status'}
	class={[
		'grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-[var(--radius-panel)] border px-4 py-3.5 text-[0.875rem] leading-relaxed',
		tone === 'caution' && 'border-caution/30 bg-caution-soft',
		tone === 'alert' && 'border-alert/30 bg-alert-soft',
		tone === 'positive' && 'border-positive/30 bg-positive-soft',
		tone === 'info' && 'border-rule bg-sunken',
		action && 'sm:grid-cols-[auto_minmax(0,1fr)_auto]',
		className
	]}
>
	<Icon
		class={[
			'mt-0.5 size-[1.125rem]',
			tone === 'caution' && 'text-caution',
			tone === 'alert' && 'text-alert',
			tone === 'positive' && 'text-positive',
			tone === 'info' && 'text-ink-soft'
		]}
		weight="fill"
		aria-hidden="true"
	/>
	<p class="font-semibold text-ink">{title}</p>
	{#if action}
		<div class="col-start-2 row-start-auto mt-2 flex gap-2 sm:col-start-3 sm:row-span-2 sm:row-start-1 sm:mt-0 sm:self-center">
			{@render action()}
		</div>
	{/if}
	{#if children}
		<div class="col-start-2 text-ink-soft [&_a]:link [&_code]:rounded-[0.25rem] [&_code]:bg-hover [&_code]:px-1 [&_code]:py-px [&_code]:text-[0.8125rem] [&_code]:text-ink">
			{@render children()}
		</div>
	{/if}
</div>
