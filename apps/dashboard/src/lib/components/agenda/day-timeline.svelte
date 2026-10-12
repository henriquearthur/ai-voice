<script lang="ts">
	import MapPin from 'phosphor-svelte/lib/MapPin';
	import {
		clampedMinutes,
		formatHour,
		formatTime,
		layoutDay,
		minutesOfDay,
		toneStyle,
		type Occurrence
	} from '#lib/agenda/time.js';

	let { items, dayKey, now }: { items: ReadonlyArray<Occurrence>; dayKey: string; now: number } = $props();

	// The window always covers a working day and stretches to whatever is booked outside it.
	const bounds = $derived.by(() => {
		const spans = items.map((i) => clampedMinutes(i, dayKey));
		return {
			first: Math.min(8, ...spans.map((m) => Math.floor(m.start / 60))),
			last: Math.min(24, Math.max(19, ...spans.map((m) => Math.ceil(m.end / 60))))
		};
	});

	const windowStart = $derived(bounds.first * 60);
	const windowEnd = $derived(bounds.last * 60);
	const hours = $derived(Array.from({ length: bounds.last - bounds.first + 1 }, (_, i) => bounds.first + i));
	const span = $derived(bounds.last - bounds.first);
	const placed = $derived(layoutDay(items, dayKey, windowStart));

	const nowMinutes = $derived(minutesOfDay(now));
	const nowVisible = $derived(nowMinutes >= windowStart && nowMinutes <= windowEnd);
	/** How far the past shading reaches, in hours from the top of the window. */
	const pastHours = $derived(Math.min(Math.max(nowMinutes - windowStart, 0), windowEnd - windowStart) / 60);
	// An hour label the "now" tag would sit on is dropped instead of overlapping it.
	const hiddenHour = (hour: number) => nowVisible && Math.abs(hour * 60 - nowMinutes) < 16;
</script>

<div
	class="relative grid grid-cols-[3rem_minmax(0,1fr)] gap-x-2.5 [--hour:3.75rem] sm:grid-cols-[3.75rem_minmax(0,1fr)] sm:gap-x-4 sm:[--hour:4.25rem]"
	style="height: calc(var(--hour) * {span} + 1.25rem)"
>
	<div class="relative mt-2.5" aria-hidden="true">
		{#each hours as hour (hour)}
			<span
				class={[
					'tabular absolute right-0 -translate-y-1/2 text-micro transition-opacity duration-150',
					hour * 60 < nowMinutes ? 'text-ink-faint' : 'text-ink-soft',
					hiddenHour(hour) && 'opacity-0'
				]}
				style="top: calc(var(--hour) * {hour - bounds.first})">{formatHour(hour)}</span
			>
		{/each}

		{#if nowVisible}
			<span
				class="tabular absolute right-0 z-10 -translate-y-1/2 rounded-sm bg-brand px-1 py-px text-micro font-semibold text-brand-contrast"
				style="top: calc(var(--hour) * {(nowMinutes - windowStart) / 60})">{formatTime(now)}</span
			>
		{/if}
	</div>

	<div class="relative mt-2.5">
		<!-- What already happened today sits on the sunken surface. -->
		<div
			class="absolute inset-x-0 top-0 rounded-t-sm bg-sunken"
			style="height: calc(var(--hour) * {pastHours})"
			aria-hidden="true"
		></div>

		{#each hours as hour, index (hour)}
			<div class="absolute inset-x-0 border-t border-rule" style="top: calc(var(--hour) * {index})" aria-hidden="true"
			></div>
			{#if index < span}
				<div
					class="absolute inset-x-0 border-t border-dashed border-rule/60"
					style="top: calc(var(--hour) * {index + 0.5})"
					aria-hidden="true"
				></div>
			{/if}
		{/each}

		<ol class="absolute inset-0" aria-label="Compromissos com horário">
			{#each placed as { item, top, height, lane, lanes }, index (item.key)}
				{@const past = item.end <= now}
				{@const live = item.start <= now && item.end > now}
				{@const compact = height < 50}
				<li
					class={['entry cal-block absolute overflow-hidden rounded-md border', live && 'cal-live', past && 'opacity-55']}
					style="{toneStyle(item.event.calendar)}; --i: {Math.min(index, 8)}; top: calc(var(--hour) * {top /
						60} + 1px); height: calc(var(--hour) * {height / 60} - 2px); left: calc({lane} * 100% / {lanes}); width: calc(100% / {lanes} - 3px)"
				>
					<div class={['h-full px-2.5', compact ? 'flex items-center gap-2' : 'py-1.5']}>
						<p class={['min-w-0 text-meta font-semibold text-ink', compact ? 'truncate' : 'line-clamp-2']}>
							{item.event.title}
						</p>
						<p class="tabular shrink-0 text-micro text-ink-soft">
							<span class="sr-only">das</span>
							{formatTime(item.start)}{#if !compact}<span aria-hidden="true">–</span><span class="sr-only">às</span
								>{formatTime(item.end)}{/if}
						</p>
						{#if !compact && height >= 75}
							<p class="mt-1 flex min-w-0 items-center gap-1 text-micro text-ink-soft">
								{#if item.event.location?.trim()}
									<MapPin class="size-3 shrink-0" weight="bold" aria-hidden="true" />
									<span class="truncate">{item.event.location.trim()}</span>
								{:else}
									<span class="truncate">{item.event.calendar}</span>
								{/if}
							</p>
						{/if}
					</div>
				</li>
			{/each}
		</ol>

		{#if nowVisible}
			<div
				class="pointer-events-none absolute inset-x-0 z-10 flex items-center"
				style="top: calc(var(--hour) * {(nowMinutes - windowStart) / 60})"
			>
				<span class="-ml-[3px] size-1.5 rounded-full bg-brand" aria-hidden="true"></span>
				<span class="h-[1.5px] flex-1 bg-brand" aria-hidden="true"></span>
				<span class="sr-only">Agora, {formatTime(now)}</span>
			</div>
		{/if}
	</div>
</div>

<style>
	/* One authored moment: the day's blocks settle in, top to bottom, the first time it is drawn. */
	.entry {
		transition:
			opacity 260ms var(--ease-out),
			translate 260ms var(--ease-out);
		transition-delay: calc(var(--i) * 35ms);

		@starting-style {
			opacity: 0;
			translate: 0 6px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.entry {
			transition-property: opacity;
			transition-delay: 0ms;
		}
	}
</style>
