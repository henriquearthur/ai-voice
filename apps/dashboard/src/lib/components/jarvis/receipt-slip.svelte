<script lang="ts">
	import type { Snippet } from 'svelte';
	import { prefersReducedMotion } from 'svelte/motion';
	import type { TransitionConfig } from 'svelte/transition';
	import CheckCircle from 'phosphor-svelte/lib/CheckCircle';
	import WarningOctagon from 'phosphor-svelte/lib/WarningOctagon';
	import Circle from 'phosphor-svelte/lib/CircleDashed';

	type Tone = 'positive' | 'neutral' | 'alert';

	/**
	 * The receipt every Jarvis action leaves behind: a dashed tear edge, a seal with the verdict and the
	 * time, a one-line title and whatever details the module wants to file under it.
	 * `tone` colours the seal: positive (default) for accepted, neutral for pending, alert for refused.
	 */
	let {
		stamp,
		at,
		title,
		tone = 'positive',
		children
	}: { stamp: string; at: number; title: string; tone?: Tone; children?: Snippet } = $props();

	const id = $props.id();

	const time = $derived(
		new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(at)
	);

	const icons = { positive: CheckCircle, neutral: Circle, alert: WarningOctagon };
	const Icon = $derived(icons[tone]);

	// The receipt unrolls down from the edge that produced it; reduced motion keeps only the fade.
	function unroll(_node: Element): TransitionConfig {
		const still = prefersReducedMotion.current;
		return {
			duration: still ? 160 : 300,
			easing: (t) => 1 - Math.pow(1 - t, 4),
			css: (t, u) =>
				still
					? `opacity: ${t}`
					: `opacity: ${Math.min(1, t * 1.8)}; clip-path: inset(0 0 ${u * 100}% 0); transform: translateY(${-6 * u}px)`
		};
	}

	// The seal settles in after the paper: a short scale-down with a blur that clears.
	function seal(_node: Element): TransitionConfig {
		const still = prefersReducedMotion.current;
		return {
			delay: still ? 0 : 160,
			duration: still ? 160 : 240,
			easing: (t) => 1 - Math.pow(1 - t, 3),
			css: (t, u) =>
				still ? `opacity: ${t}` : `opacity: ${t}; transform: scale(${1 + 0.12 * u}); filter: blur(${3 * u}px)`
		};
	}
</script>

<section in:unroll aria-labelledby="{id}-title" class="relative pt-4">
	<div aria-hidden="true" class="perforated absolute inset-x-3 top-0 h-px"></div>
	<div
		class="relative grid gap-3 rounded-[var(--radius-panel)] border border-rule bg-sunken px-4 pt-3.5 pb-4 sm:px-5"
	>
		<div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
			<h2 id="{id}-title" class="min-w-0 flex-1 pt-0.5 text-[0.9375rem] font-semibold text-ink">
				{title}
				<span class="sr-only">Às {time}.</span>
			</h2>
			<div
				in:seal
				aria-hidden="true"
				class={[
					'inline-flex shrink-0 origin-right items-center gap-1.5 rounded-full border py-1 pr-2.5 pl-1.5 text-micro font-semibold',
					tone === 'positive' && 'border-positive/30 bg-positive-soft text-positive',
					tone === 'neutral' && 'border-rule-strong bg-raised text-ink-soft',
					tone === 'alert' && 'border-alert/30 bg-alert-soft text-alert'
				]}
			>
				<Icon class="size-4" weight="fill" />
				<span class="tracking-[0.04em] uppercase">{stamp}</span>
				<span class="tabular font-mono font-medium opacity-80">{time}</span>
			</div>
		</div>

		{@render children?.()}
	</div>
</section>
