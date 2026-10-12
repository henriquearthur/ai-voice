<script lang="ts">
	import { RANGE_DAYS, toneStyle, type AgendaRange } from '#lib/agenda/time.js';

	let {
		range,
		calendar,
		calendars
	}: { range: AgendaRange; calendar: string | null; calendars: ReadonlyArray<string> } = $props();

	const href = (next: { range?: AgendaRange; calendar?: string | null }) => {
		const params = new URLSearchParams();
		const r = next.range ?? range;
		const c = next.calendar === undefined ? calendar : next.calendar;
		if (r === 'semana') params.set('periodo', 'semana');
		if (c) params.set('calendario', c);
		const query = params.toString();
		return query ? `/agenda?${query}` : '/agenda';
	};

	// Two accounts can each carry a calendar with the same name (holidays, birthdays); the filter is by name, so one chip each.
	const names = $derived([...new Set(calendars)]);

	const ranges: ReadonlyArray<{ id: AgendaRange; label: string }> = [
		{ id: 'hoje', label: 'Hoje' },
		{ id: 'semana', label: `${RANGE_DAYS.semana} dias` }
	];
</script>

<!-- Filters live in the URL: each option is a link, so a view can be bookmarked and the load reads exactly what is shown. -->
<div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
	<nav aria-label="Período" class="segmented w-full sm:w-fit">
		{#each ranges as item (item.id)}
			<a
				href={href({ range: item.id })}
				data-sveltekit-reset="false"
				aria-current={item.id === range ? 'page' : undefined}
				class="segment sm:px-5"
			>
				{item.label}
			</a>
		{/each}
	</nav>

	{#if names.length > 1}
		<nav aria-label="Calendários" class="w-full min-w-0 overflow-x-auto sm:w-auto sm:flex-1">
			<ul class="flex w-max gap-1 sm:w-auto sm:flex-wrap sm:justify-end">
				<li>
					<a
						href={href({ calendar: null })}
						data-sveltekit-reset="false"
						aria-current={calendar === null ? 'page' : undefined}
						class="legend">Todos</a
					>
				</li>
				{#each names as name (name)}
					<li>
						<a
							href={href({ calendar: name })}
							data-sveltekit-reset="false"
							aria-current={name === calendar ? 'page' : undefined}
							class="legend"
						>
							<span class="cal-dot size-2 shrink-0 rounded-full" style={toneStyle(name)} aria-hidden="true"></span>
							{name}
						</a>
					</li>
				{/each}
			</ul>
		</nav>
	{/if}
</div>

<style>
	/* A calendar legend that doubles as the filter: quiet until chosen, then underlined in ink. */
	.legend {
		display: inline-flex;
		height: 2rem;
		align-items: center;
		gap: 0.5rem;
		border-radius: var(--radius);
		padding-inline: 0.625rem;
		font-size: 0.875rem;
		font-weight: 500;
		white-space: nowrap;
		color: var(--ink-soft);
		text-decoration-line: underline;
		text-decoration-color: transparent;
		text-decoration-thickness: 2px;
		text-underline-offset: 0.45em;
		transition-property: background-color, color, text-decoration-color, scale;
		transition-duration: 150ms;
		transition-timing-function: var(--ease-out);
	}
	.legend:active {
		scale: 0.97;
	}
	.legend[aria-current='page'] {
		color: var(--ink);
		font-weight: 600;
		text-decoration-color: var(--ink);
	}
	@media (pointer: coarse) {
		.legend {
			height: 2.75rem;
		}
	}
	@media (hover: hover) and (pointer: fine) {
		.legend:hover:not([aria-current='page']) {
			background-color: var(--hover);
			color: var(--ink);
		}
	}
</style>
