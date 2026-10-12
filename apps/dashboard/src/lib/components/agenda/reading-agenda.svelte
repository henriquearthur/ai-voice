<script lang="ts">
	import ConsentHint from '#lib/components/apple/consent-hint.svelte';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import type { AgendaRange } from '#lib/agenda/time.js';

	let { range }: { range: AgendaRange } = $props();
</script>

<div class="grid gap-6" aria-busy="true">
	<p class="sr-only" role="status">Lendo a agenda…</p>

	<ConsentHint app="Calendário" />

	<!-- The same frame the answer will fill, so nothing jumps when it arrives. -->
	{#if range === 'hoje'}
		<div class="grid gap-8 lg:grid-cols-[17rem_1fr] lg:gap-12" aria-hidden="true">
			<div class="grid content-start gap-6">
				<div class="flex items-end gap-3.5">
					<Skeleton class="h-14 w-16" />
					<div class="grid gap-1.5 pb-0.5">
						<Skeleton class="h-4 w-24" />
						<Skeleton class="h-3.5 w-20" />
					</div>
				</div>
				<Skeleton class="h-[5.5rem] rounded-lg" />
			</div>
			<div class="grid gap-3">
				{#each [0.5, 1.25, 0.75, 1] as size, index (index)}
					<div class="grid grid-cols-[3rem_1fr] items-start gap-x-2.5 sm:grid-cols-[3.75rem_1fr] sm:gap-x-4">
						<Skeleton class="mt-1 ml-auto h-3 w-9" />
						<Skeleton style="height: {size * 4}rem" />
					</div>
				{/each}
			</div>
		</div>
	{:else}
		<div class="grid gap-4 border-y border-rule py-4 lg:grid-cols-7" aria-hidden="true">
			{#each [2, 1, 3, 0, 2, 1, 0] as count, index (index)}
				<div class="grid grid-cols-[3.25rem_1fr] content-start gap-x-4 gap-y-2 sm:grid-cols-[4rem_1fr] lg:grid-cols-1">
					<Skeleton class="h-9 w-10" />
					<div class="grid gap-2">
						{#each { length: Math.max(count, 1) } as _, i (i)}
							<Skeleton class={['h-10', count === 0 && 'w-12 opacity-50']} />
						{/each}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
