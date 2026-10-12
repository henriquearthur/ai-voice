<script lang="ts">
	import ConsentHint from '#lib/components/apple/consent-hint.svelte';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';

	// The same shape the ledger will have: a heading on a rule, then ruled rows with the time column on the left.
	const groups = [
		{ heading: 'w-16', rows: ['w-3/5', 'w-2/5', 'w-1/2'] },
		{ heading: 'w-24', rows: ['w-1/2', 'w-2/3'] }
	];
</script>

<div class="grid gap-7" aria-busy="true">
	<p class="sr-only" role="status">Lendo os lembretes…</p>

	<ConsentHint app="Lembretes" />

	{#each groups as group, index (index)}
		<div aria-hidden="true">
			<div class="flex items-center gap-3 pb-2.5">
				<Skeleton class={['h-3', group.heading]} />
				<span class="h-px flex-1 bg-rule"></span>
			</div>
			{#each group.rows as width, row (row)}
				<div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-b border-rule py-3.5 sm:grid-cols-[5.25rem_minmax(0,1fr)]">
					<Skeleton class="order-last h-3 w-10 sm:order-none" />
					<Skeleton class={['h-3.5', width]} />
				</div>
			{/each}
		</div>
	{/each}
</div>
