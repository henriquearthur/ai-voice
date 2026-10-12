<script lang="ts">
	import MapPin from 'phosphor-svelte/lib/MapPin';
	import {
		addDays,
		dateParts,
		dayStartMs,
		forDay,
		timeLabel,
		toneStyle,
		type Occurrence
	} from '#lib/agenda/time.js';

	let {
		items,
		today,
		days,
		now
	}: { items: ReadonlyArray<Occurrence>; today: string; days: number; now: number } = $props();

	const columns = $derived(
		Array.from({ length: days }, (_, i) => {
			const key = addDays(today, i);
			const dayItems = forDay(items, key);
			// Noon in São Paulo is still the same date in UTC, so the UTC weekday is the local one.
			const weekday = new Date(dayStartMs(key) + 12 * 60 * 60 * 1000).getUTCDay();
			return {
				key,
				date: dateParts(key),
				weekend: weekday === 0 || weekday === 6,
				allDay: dayItems.filter((i) => i.event.allDay),
				timed: dayItems.filter((i) => !i.event.allDay)
			};
		})
	);
</script>

<!-- A planner spread: a row per day on a phone, the seven days side by side on a wide screen. -->
<ol class="grid border-y border-rule lg:grid-cols-7 lg:divide-x lg:divide-rule">
	{#each columns as day (day.key)}
		{@const isToday = day.key === today}
		{@const empty = day.allDay.length === 0 && day.timed.length === 0}
		<li
			aria-labelledby="dia-{day.key}"
			class={[
				'grid min-w-0 grid-cols-[3.25rem_minmax(0,1fr)] content-start gap-x-4 gap-y-3 border-b border-rule py-4 last:border-b-0 sm:grid-cols-[4rem_minmax(0,1fr)]',
				'lg:min-h-[19rem] lg:grid-cols-1 lg:border-b-0 lg:px-2 lg:pt-3 lg:pb-5',
				day.weekend && 'lg:bg-sunken/70'
			]}
		>
			<h2
				id="dia-{day.key}"
				class="flex flex-col items-start gap-1 lg:flex-row lg:items-center lg:justify-between lg:px-1"
			>
				<span class={['text-micro font-semibold', isToday ? 'text-brand' : 'text-ink-soft']}>
					{day.date.weekdayShort}
				</span>
				<span
					class={[
						'display tabular grid h-9 min-w-9 place-items-center rounded-full text-[1.375rem] leading-none',
						isToday ? 'bg-brand px-2 text-brand-contrast' : 'text-ink'
					]}
				>
					{day.date.day}
				</span>
				<span class="sr-only">de {day.date.month}{isToday ? ', hoje' : ''}</span>
			</h2>

			{#if empty}
				<p class="self-center text-meta text-ink-faint lg:self-start lg:px-1">Livre</p>
			{:else}
				<ul class="grid min-w-0 content-start gap-1">
					{#each day.allDay as item (item.key)}
						<li
							class="cal-block rounded-sm border px-2 py-1 text-meta font-semibold text-ink"
							style={toneStyle(item.event.calendar)}
						>
							<span class="line-clamp-2">{item.event.title}</span>
							<span class="sr-only">, dia inteiro, {item.event.calendar}</span>
						</li>
					{/each}
					{#each day.timed as item (item.key)}
						{@const live = item.start <= now && item.end > now}
						<li
							class={['grid grid-cols-[0.5rem_minmax(0,1fr)] gap-x-2 px-1 py-1.5', item.end <= now && 'opacity-55']}
							style={toneStyle(item.event.calendar)}
						>
							<span class="cal-dot mt-[0.375rem] size-2 rounded-full" aria-hidden="true"></span>
							<div class="min-w-0">
								<p class="tabular text-micro text-ink-soft">
									{timeLabel(item, day.key)}
									{#if live}<span class="ml-1 font-semibold text-brand">agora</span>{/if}
								</p>
								<p class="text-body leading-snug font-semibold text-ink lg:line-clamp-3 lg:text-meta">
									{item.event.title}
								</p>
								{#if item.event.location?.trim()}
									<p class="mt-0.5 flex min-w-0 items-center gap-1 text-micro text-ink-soft">
										<MapPin class="size-3 shrink-0" weight="bold" aria-hidden="true" />
										<span class="truncate">{item.event.location.trim()}</span>
									</p>
								{/if}
								<span class="sr-only">, {item.event.calendar}</span>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</li>
	{/each}
</ol>
