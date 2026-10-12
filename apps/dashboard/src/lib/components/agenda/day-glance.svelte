<script lang="ts">
	import AllDayStrip from './all-day-strip.svelte';
	import { RANGE_DAYS, addDays, dateParts, dayStartMs, formatSpan, formatTime, toneStyle, type Occurrence } from '#lib/agenda/time.js';

	let {
		dayKey,
		allDay,
		timed,
		now,
		weekHref
	}: {
		dayKey: string;
		allDay: ReadonlyArray<Occurrence>;
		timed: ReadonlyArray<Occurrence>;
		now: number;
		/** Where "the next days" lives, keeping the calendar filter. */
		weekHref: string;
	} = $props();

	const date = $derived(dateParts(dayKey));
	const current = $derived(timed.filter((i) => i.start <= now && i.end > now));
	const next = $derived(timed.find((i) => i.start > now));
	const ahead = $derived(timed.filter((i) => i.end > now).length);
	const lastEnd = $derived(timed.reduce((end, i) => Math.max(end, i.end), 0));
	const focus = $derived(current[0] ?? next);
	// Something running past midnight leaves no free evening to announce.
	const freeAt = $derived(lastEnd < dayStartMs(addDays(dayKey, 1)) ? lastEnd : null);
</script>

<section aria-labelledby="agenda-day" class="grid content-start gap-6">
	<h2 id="agenda-day" class="flex items-end gap-3.5">
		<span class="display tabular text-[4.5rem] leading-[0.78] text-ink">{date.day}</span>
		<span class="grid pb-0.5 leading-tight">
			<span class="text-[1.125rem] font-semibold text-ink first-letter:uppercase">{date.weekday}</span>
			<span class="text-[0.9375rem] text-ink-soft">de {date.month}</span>
		</span>
	</h2>

	<div class="panel px-4 py-3.5" aria-live="polite">
		{#if focus}
			{@const live = focus.start <= now}
			<div class="flex items-start gap-2.5">
				<span class="relative mt-[0.5rem] flex size-2 shrink-0" style={toneStyle(focus.event.calendar)} aria-hidden="true">
					<span class="cal-dot relative size-2 rounded-full"></span>
				</span>
				<div class="min-w-0">
					<p class="text-heading font-semibold text-pretty text-ink">{focus.event.title}</p>
					<p class="mt-1 text-meta text-ink-soft">
						{#if live}
							Agora, até <span class="tabular text-ink">{formatTime(focus.end)}</span>
							<span class="whitespace-nowrap">· faltam {formatSpan(focus.end - now)}</span>
						{:else}
							Às <span class="tabular text-ink">{formatTime(focus.start)}</span>
							<span class="whitespace-nowrap">· em {formatSpan(focus.start - now)}</span>
						{/if}
					</p>
					{#if live && current.length > 1}
						<p class="mt-1 text-meta text-ink-soft">
							e mais {current.length - 1} {current.length === 2 ? 'evento' : 'eventos'} ao mesmo tempo
						</p>
					{/if}
					{#if focus.event.location}
						<p class="mt-1 truncate text-meta text-ink-soft">{focus.event.location}</p>
					{/if}
				</div>
			</div>
			{#if live && next}
				<p class="mt-3 border-t border-rule pt-3 text-meta text-ink-soft">
					Depois: <span class="font-semibold text-ink">{next.event.title}</span>
					às <span class="tabular">{formatTime(next.start)}</span>
				</p>
			{/if}
		{:else if timed.length > 0}
			<p class="font-semibold text-ink">Nada mais com horário hoje.</p>
			<p class="mt-1 text-meta text-ink-soft">
				Livre desde as <span class="tabular">{formatTime(lastEnd)}</span>.
			</p>
		{:else}
			<p class="font-semibold text-ink">
				{allDay.length > 0 ? 'Nenhum compromisso com horário.' : 'Nada marcado para hoje.'}
			</p>
			<p class="mt-1 text-meta text-ink-soft">
				O dia está aberto.
				<a href={weekHref} data-sveltekit-reset="false" class="link font-medium">Ver os próximos {RANGE_DAYS.semana} dias</a>
			</p>
		{/if}
	</div>

	{#if allDay.length > 0}
		<AllDayStrip items={allDay} />
	{/if}

	{#if ahead > 0}
		<p class="text-meta text-ink-soft">
			<span class="tabular text-ink">{ahead}</span>
			{ahead === 1 ? 'compromisso pela frente' : 'compromissos pela frente'}{#if freeAt !== null}, livre a partir das
				<span class="tabular text-ink">{formatTime(freeAt)}</span>{/if}.
		</p>
	{/if}
</section>
