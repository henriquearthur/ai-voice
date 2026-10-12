<script lang="ts">
	import type { Reminder } from '@jarvis/apple';
	import Check from 'phosphor-svelte/lib/Check';
	import { HORIZONS, describeDue, horizonOf, type Due, type Horizon } from '#lib/reminders/due.js';
	import type { Grouping } from '#lib/reminders/view.js';

	let {
		lists,
		items,
		list,
		includeCompleted,
		group,
		query,
		fresh
	}: {
		lists: ReadonlyArray<string>;
		/** Already narrowed by the search box. */
		items: ReadonlyArray<Reminder>;
		list: string | null;
		includeCompleted: boolean;
		group: Grouping;
		query: string;
		/** Id of the reminder just added from this page, marked once so the eye finds it. */
		fresh: string | null;
	} = $props();

	type Row = { reminder: Reminder; due: Due | null; horizon: Horizon };
	type Group = { key: string; label: string; tone: 'alert' | 'carbon' | 'soft'; rows: ReadonlyArray<Row> };

	// Open before done, then by due date with undated last; ties keep the order Reminders gave.
	const compare = (a: Row, b: Row) =>
		Number(a.reminder.completed) - Number(b.reminder.completed) ||
		(a.due?.at ?? Number.POSITIVE_INFINITY) - (b.due?.at ?? Number.POSITIVE_INFINITY);

	const rows = $derived.by(() => {
		const now = new Date();
		return items
			.map((reminder): Row => {
				const due = reminder.due ? describeDue(reminder.due, now) : null;
				return { reminder, due, horizon: horizonOf(reminder.completed, due) };
			})
			.sort(compare);
	});

	const groups = $derived.by((): ReadonlyArray<Group> => {
		if (group === 'prazo') {
			const byHorizon = Map.groupBy(rows, (row) => row.horizon);
			return (Object.keys(HORIZONS) as Horizon[])
				.map((key) => ({
					key,
					label: HORIZONS[key],
					tone: key === 'overdue' ? 'alert' : key === 'done' ? 'soft' : key === 'today' ? 'carbon' : 'soft',
					rows: byHorizon.get(key) ?? []
				}))
				.filter((entry) => entry.rows.length > 0) as Group[];
		}
		const byList = Map.groupBy(rows, (row) => row.reminder.list);
		const order = list === null ? lists : [list];
		// Lists the lists call did not report (renamed mid-read) still show, at the end.
		const names = [...order, ...[...byList.keys()].filter((name) => !order.includes(name))];
		return names
			.map((name): Group => ({ key: name, label: name, tone: 'carbon', rows: byList.get(name) ?? [] }))
			.filter((entry) => entry.rows.length > 0);
	});

	const open = (entries: ReadonlyArray<Row>) => entries.filter((row) => !row.reminder.completed).length;

	// The left column says only what the heading has not said already.
	const when = (row: Row): { day: string | null; time: string | null } => {
		const { due, horizon } = row;
		if (due === null) return { day: null, time: null };
		if (group === 'prazo' && (horizon === 'today' || horizon === 'tomorrow')) {
			return { day: due.time === null ? 'dia todo' : null, time: due.time };
		}
		return { day: due.brief, time: due.time };
	};

	// The list name earns a column only when the rows come from more than one list.
	const showList = $derived(group === 'prazo' && list === null && lists.length > 1);
	const searching = $derived(query.trim() !== '');
</script>

{#if groups.length === 0}
	<div class="empty border-t border-rule pt-8 pb-4">
		{#if searching}
			<p class="display text-[1.25rem] text-ink">Nada com “{query.trim()}”.</p>
			<p class="mt-1.5 max-w-[34rem] text-sm text-ink-soft">
				A busca olha título, notas e nome da lista{includeCompleted ? '' : ', só entre os pendentes'}. Aperte Esc para limpar.
			</p>
		{:else}
			<p class="display text-[1.25rem] text-ink">{includeCompleted ? 'Nenhum lembrete aqui.' : 'Nada pendente.'}</p>
			<p class="mt-1.5 max-w-[34rem] text-sm text-ink-soft">
				{#if list !== null}
					A lista “{list}” está vazia{includeCompleted ? '' : ' de pendências'}. Anote algo nela pelo formulário.
				{:else if lists.length === 0}
					O app Lembretes ainda não tem nenhuma lista. Crie uma no Mac ou no iPhone e atualize esta página.
				{:else}
					Tudo em dia em {lists.length === 1 ? 'uma lista' : `${lists.length} listas`}. O que surgir, anote no formulário.
				{/if}
			</p>
		{/if}
	</div>
{:else}
	<div class="grid gap-7">
		{#each groups as entry, index (entry.key)}
			{@const pending = open(entry.rows)}
			<section aria-labelledby="reminder-group-{index}">
				<header class="flex items-center gap-3 pb-1.5">
					<h2
						id="reminder-group-{index}"
						class={[
							'field-label min-w-0 truncate',
							entry.tone === 'alert' && 'text-alert',
							entry.tone === 'soft' && 'text-ink-soft'
						]}
					>
						{entry.label}
					</h2>
					<span class="tabular shrink-0 font-mono text-xs text-ink-soft">
						{#if group === 'lista'}
							{pending}
							<span class="sr-only">{pending === 1 ? 'pendente' : 'pendentes'}</span>
						{:else}
							{entry.rows.length}
						{/if}
					</span>
					<span aria-hidden="true" class={['h-px flex-1', entry.tone === 'alert' ? 'bg-alert/35' : 'bg-rule']}></span>
				</header>

				<ul>
					{#each entry.rows as row (row.reminder.id)}
						{@const { reminder, due } = row}
						{@const at = when(row)}
						<li
							class={[
								'row grid items-baseline gap-x-4 border-b border-rule py-2.5',
								showList ? 'sm:grid-cols-[5.25rem_minmax(0,1fr)_minmax(0,10rem)]' : 'sm:grid-cols-[5.25rem_minmax(0,1fr)]',
								// Phone: the time moves to the right edge, so an undated row gives its whole width to the title.
								'grid-cols-[minmax(0,1fr)_auto]',
								reminder.id === fresh && 'fresh'
							]}
						>
							<span
								class={[
									'tabular order-last text-right text-[0.8125rem] leading-5 whitespace-nowrap sm:order-none sm:text-left',
									reminder.completed
										? 'text-ink-soft'
										: due?.overdue
											? 'font-semibold text-alert'
											: due?.today
												? 'font-semibold text-carbon'
												: 'text-ink-soft'
								]}
							>
								{#if due}
									<time datetime={reminder.due} title={due.full}>
										{#if at.day}<span class="inline-block first-letter:uppercase">{at.day}</span>{/if}{#if at.day && at.time}{' '}{/if}{#if at.time}<span class="font-mono text-[0.75rem]">{at.time}</span>{/if}
									</time>
									{#if due.overdue && !reminder.completed}<span class="sr-only">, atrasado</span>{/if}
								{/if}
							</span>

							<div class="min-w-0">
								<p
									class={[
										'text-[0.9375rem] leading-5 break-words',
										reminder.completed ? 'text-ink-soft line-through decoration-rule-strong' : 'text-ink'
									]}
								>
									{#if reminder.completed}
										<Check class="mr-1 inline size-3.5 -translate-y-px text-signal" weight="bold" aria-hidden="true" />
									{/if}
									{reminder.title}
									{#if reminder.completed}<span class="sr-only">(concluído)</span>{/if}
								</p>
								{#if reminder.notes || (showList && reminder.list)}
									<p class="mt-0.5 line-clamp-2 text-[0.8125rem] leading-[1.125rem] whitespace-pre-line text-ink-soft">
										{#if showList}<span class="font-medium text-ink-soft sm:hidden">{reminder.list}{reminder.notes ? ' · ' : ''}</span>{/if}{reminder.notes ?? ''}
									</p>
								{/if}
							</div>

							{#if showList}
								<span class="hidden truncate text-right text-[0.8125rem] leading-5 text-ink-soft sm:block" title={reminder.list}>
									{reminder.list}
								</span>
							{/if}
						</li>
					{/each}
				</ul>
			</section>
		{/each}
	</div>
{/if}

<style>
	/* Ink that has not dried yet: the new line starts tinted and settles into the page. */
	.fresh {
		animation: settle 1800ms var(--ease-out) both;
	}

	/* Reduced motion: the tint still settles, as a slow fade with no movement involved. */
	@media (prefers-reduced-motion: reduce) {
		.fresh {
			animation-duration: 2400ms;
			animation-timing-function: linear;
		}
	}

	@keyframes settle {
		from {
			background-color: color-mix(in oklch, var(--carbon) 14%, transparent);
			box-shadow: -0.5rem 0 0 color-mix(in oklch, var(--carbon) 14%, transparent);
		}
		to {
			background-color: transparent;
			box-shadow: -0.5rem 0 0 transparent;
		}
	}
</style>
