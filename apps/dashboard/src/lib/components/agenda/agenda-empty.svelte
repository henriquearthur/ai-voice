<script lang="ts">
	import CalendarBlank from 'phosphor-svelte/lib/CalendarBlank';
	import { RANGE_DAYS } from '#lib/agenda/time.js';

	/** The next days hold nothing, for every calendar or for the one chosen in the filter. */
	let { calendar }: { calendar: string | null } = $props();
</script>

<section aria-labelledby="agenda-empty-title" class="well grid justify-items-center px-5 py-12 text-center">
	<CalendarBlank class="size-7 text-ink-faint" weight="duotone" aria-hidden="true" />
	<h2 id="agenda-empty-title" class="mt-3 text-heading font-semibold text-ink">
		Nada marcado nos próximos {RANGE_DAYS.semana} dias.
	</h2>
	<p class="mt-1 max-w-[30rem] text-meta text-ink-soft">
		{#if calendar}
			O calendário “{calendar}” está vazio neste período.
			<a href="/agenda?periodo=semana" data-sveltekit-reset="false" class="link font-medium">Ver todos os calendários</a>
		{:else}
			Seus calendários estão vazios neste período.
		{/if}
	</p>
</section>
