<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import ArrowClockwise from 'phosphor-svelte/lib/ArrowClockwise';
	import AgendaEmpty from '#lib/components/agenda/agenda-empty.svelte';
	import AgendaToolbar from '#lib/components/agenda/agenda-toolbar.svelte';
	import DayGlance from '#lib/components/agenda/day-glance.svelte';
	import DayTimeline from '#lib/components/agenda/day-timeline.svelte';
	import ReadingAgenda from '#lib/components/agenda/reading-agenda.svelte';
	import WeekList from '#lib/components/agenda/week-list.svelte';
	import AutomationFailure from '#lib/components/apple/automation-failure.svelte';
	import ModuleHeader from '#lib/components/jarvis/module-header.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { RANGE_DAYS, forDay, formatTime, occurrences } from '#lib/agenda/time.js';
	import { Latest } from '#lib/jarvis/latest.svelte.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// The board is streamed; the last answer stays on screen while a new one is read.
	const latest = new Latest(() => data.board);
	const board = $derived(latest.value);
	const reading = $derived(latest.pending);

	let clock = $state<number | null>(null);
	const now = $derived(clock ?? data.now);

	// The server clock seeds the first paint; after hydration the marker follows the browser's.
	$effect(() => {
		clock = Date.now();
		const timer = setInterval(() => (clock = Date.now()), 30_000);
		return () => clearInterval(timer);
	});

	const value = $derived(board?.ok ? board.value : undefined);
	const failure = $derived(board && !board.ok ? board.failure : undefined);
	const items = $derived(value ? occurrences(value.events) : []);
	const todayItems = $derived(forDay(items, data.today));
	const allDay = $derived(todayItems.filter((i) => i.event.allDay));
	const timed = $derived(todayItems.filter((i) => !i.event.allDay));
	const upcoming = $derived(items.find((i) => !i.event.allDay && i.end > now));
	const total = $derived(data.range === 'hoje' ? todayItems.length : items.length);
	const weekHref = $derived(
		value?.calendar ? `/agenda?${new URLSearchParams({ periodo: 'semana', calendario: value.calendar })}` : '/agenda?periodo=semana'
	);
	const blocking = $derived(failure?.kind === 'permission' || failure?.kind === 'timeout');
</script>

<svelte:head>
	<title>Agenda · Jarvis</title>
</svelte:head>

<div class="agenda mx-auto grid max-w-[72rem] grid-cols-[minmax(0,1fr)] gap-8">
	<ModuleHeader title="Agenda">
		{#snippet summary()}
			{#if failure}
				Sem acesso ao Calendário agora.
			{:else if !value}
				Lendo o Calendário deste Mac…
			{:else if total === 0}
				{data.range === 'hoje' ? 'Nenhum evento hoje.' : `Nenhum evento nos próximos ${RANGE_DAYS.semana} dias.`}
			{:else}
				<span class="tabular">{total}</span>
				{total === 1 ? 'evento' : 'eventos'}
				{data.range === 'hoje' ? 'hoje' : `em ${RANGE_DAYS.semana} dias`}.
				{#if upcoming && data.range === 'semana'}
					Próximo: <span class="text-ink">{upcoming.event.title}</span>
					às <span class="tabular">{formatTime(upcoming.start)}</span>.
				{/if}
			{/if}
		{/snippet}
		{#snippet actions()}
			<Button variant="outline" onclick={() => refreshAll()} disabled={reading}>
				<ArrowClockwise class={['size-4', reading && board && 'animate-spin']} weight="bold" aria-hidden="true" />
				{reading && board ? 'Atualizando…' : 'Atualizar'}
			</Button>
		{/snippet}
	</ModuleHeader>

	{#if failure && blocking}
		<AutomationFailure {failure} app="Calendário" />
	{:else}
		<AgendaToolbar range={data.range} calendar={value?.calendar ?? null} calendars={value?.calendars ?? []} />

		<div class={['grid gap-6 transition-opacity duration-200', reading && board && 'opacity-60']} aria-busy={reading}>
			{#if !board}
				<ReadingAgenda range={data.range} />
			{:else if failure}
				<AutomationFailure {failure} app="Calendário" />
			{:else if data.range === 'hoje'}
				<!-- Today is always drawn as a day, even an empty one: the date and what is next are the answer. -->
				<div class={['grid gap-8 lg:gap-12', timed.length > 0 ? 'lg:grid-cols-[17rem_minmax(0,1fr)]' : 'max-w-[26rem]']}>
					<div class="lg:sticky lg:top-6 lg:self-start">
						<DayGlance dayKey={data.today} {allDay} {timed} {now} {weekHref} />
					</div>
					{#if timed.length > 0}
						<DayTimeline items={timed} dayKey={data.today} {now} />
					{/if}
				</div>
			{:else if total === 0}
				<AgendaEmpty calendar={value?.calendar ?? null} />
			{:else}
				<WeekList {items} today={data.today} days={RANGE_DAYS.semana} {now} />
			{/if}
		</div>
	{/if}
</div>

<style>
	/*
	 * Calendar hues: six categorical colours of equal weight, so no calendar shouts louder than another.
	 * They only ever tint (blocks, dots); titles stay in ink. Picked per calendar name by `toneOf`.
	 */
	.agenda {
		--cal-0: oklch(0.55 0.13 240);
		--cal-1: oklch(0.55 0.12 155);
		--cal-2: oklch(0.6 0.12 70);
		--cal-3: oklch(0.55 0.14 300);
		--cal-4: oklch(0.57 0.15 15);
		--cal-5: oklch(0.56 0.09 195);
	}
	:global(.dark) .agenda {
		--cal-0: oklch(0.78 0.11 240);
		--cal-1: oklch(0.78 0.12 155);
		--cal-2: oklch(0.82 0.11 75);
		--cal-3: oklch(0.76 0.12 300);
		--cal-4: oklch(0.75 0.13 15);
		--cal-5: oklch(0.8 0.08 195);
	}

	.agenda :global(.cal-dot) {
		background-color: var(--cal);
	}
	.agenda :global(.cal-block) {
		border-color: color-mix(in oklch, var(--cal) 34%, var(--raised));
		background-color: color-mix(in oklch, var(--cal) 12%, var(--raised));
	}
	/* The event happening now stands up off the page: full-strength edge, a soft shadow in its own hue. */
	.agenda :global(.cal-live) {
		border-color: var(--cal);
		box-shadow: 0 8px 20px -14px var(--cal);
	}
</style>
