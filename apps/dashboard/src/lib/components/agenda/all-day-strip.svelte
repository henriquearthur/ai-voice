<script lang="ts">
	import { toneStyle, type Occurrence } from '#lib/agenda/time.js';

	let { items }: { items: ReadonlyArray<Occurrence> } = $props();
</script>

<section aria-labelledby="agenda-all-day" class="grid gap-2">
	<h3 id="agenda-all-day" class="field-label">Dia inteiro</h3>
	<ul class="grid gap-1.5">
		{#each items as { key, event } (key)}
			<li class="cal-block grid gap-0.5 rounded-md border px-3 py-2" style={toneStyle(event.calendar)}>
				<span class="text-meta font-semibold text-pretty text-ink">{event.title}</span>
				<span class="truncate text-micro text-ink-soft">{event.calendar}</span>
			</li>
		{/each}
	</ul>
</section>
