<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { page } from '$app/state';
	import ArrowClockwise from 'phosphor-svelte/lib/ArrowClockwise';
	import AutomationFailure from '#lib/components/apple/automation-failure.svelte';
	import ModuleHeader from '#lib/components/jarvis/module-header.svelte';
	import AddReminder from '#lib/components/reminders/add-reminder.svelte';
	import ListFilter from '#lib/components/reminders/list-filter.svelte';
	import ReadingReminders from '#lib/components/reminders/reading-reminders.svelte';
	import ReminderLedger from '#lib/components/reminders/reminder-ledger.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Latest } from '#lib/jarvis/latest.svelte.js';
	import { describeDue } from '#lib/reminders/due.js';
	import { groupingFrom, matcher, type View } from '#lib/reminders/view.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// The board is streamed; the last answer stays on screen while a new one is read.
	const latest = new Latest(() => data.board);
	const board = $derived(latest.value);
	const reading = $derived(latest.pending);

	const value = $derived(board?.ok ? board.value : undefined);
	const lists = $derived(value?.lists ?? []);
	const fresh = $derived(form && 'added' in form && form.added ? form.added.reminder.id : null);
	const view = $derived<View>({
		list: value ? value.list : data.filter.list,
		includeCompleted: data.filter.includeCompleted,
		group: groupingFrom(page.url.searchParams)
	});

	let query = $state('');
	const matches = $derived(matcher(query));
	const shown = $derived(value ? value.items.filter(matches) : []);

	const pending = $derived(value ? value.items.filter((item) => !item.completed) : []);
	const overdue = $derived.by(() => {
		const now = new Date();
		return pending.filter((item) => (item.due ? describeDue(item.due, now)?.overdue : false)).length;
	});

	// Single keys reach the two things this page is for, unless the user is already typing somewhere.
	const typing = (target: EventTarget | null) =>
		target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

	const onkeydown = (event: KeyboardEvent) => {
		if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
		const id = event.key === '/' ? 'reminder-search' : event.key === 'n' || event.key === 'N' ? 'reminder-title' : null;
		const field = id ? document.getElementById(id) : null;
		if (field instanceof HTMLInputElement) {
			event.preventDefault();
			field.focus();
			field.select();
		}
	};
</script>

<svelte:head>
	<title>Lembretes · Jarvis</title>
</svelte:head>

<svelte:window {onkeydown} />

<div class="mx-auto grid max-w-[72rem] gap-8">
	<ModuleHeader title="Lembretes">
		{#snippet summary()}
			{#if value}
				<span class="tabular">{pending.length}</span>
				{pending.length === 1 ? 'pendente' : 'pendentes'}
				{#if value.list === null}
					em <span class="tabular">{lists.length}</span> {lists.length === 1 ? 'lista' : 'listas'}{overdue > 0 ? ',' : '.'}
				{:else}
					em {value.list}{overdue > 0 ? ',' : '.'}
				{/if}
				{#if overdue > 0}
					<span class="font-semibold text-alert"
						><span class="tabular">{overdue}</span> {overdue === 1 ? 'atrasado' : 'atrasados'}.</span
					>
				{/if}
			{:else if board && !board.ok}
				Sem acesso ao app Lembretes agora.
			{:else}
				Lendo o app Lembretes deste Mac…
			{/if}
		{/snippet}
		{#snippet actions()}
			<Button variant="outline" onclick={() => refreshAll()} disabled={reading}>
				<ArrowClockwise class={['size-4', reading && board && 'animate-spin']} weight="bold" aria-hidden="true" />
				{reading && board ? 'Atualizando…' : 'Atualizar'}
			</Button>
		{/snippet}
	</ModuleHeader>

	{#if board && !board.ok && (board.failure.kind === 'permission' || board.failure.kind === 'timeout')}
		<AutomationFailure failure={board.failure} app="Lembretes" />
	{:else}
		<div class="grid items-start gap-x-10 gap-y-10 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,21rem)] xl:gap-x-14">
			<!-- First in the DOM so a phone reaches the capture form without scrolling past every list. -->
			<aside class="lg:sticky lg:top-10 lg:order-2">
				<AddReminder
					{lists}
					preferredList={value?.list ?? null}
					result={form}
					titleMax={data.limits.title}
					notesMax={data.limits.notes}
				/>
			</aside>
			<div class="grid min-w-0 gap-6 lg:order-1">
				{#if value}
					<ListFilter {lists} {view} bind:query shown={shown.length} total={value.items.length} />
				{/if}

				<div class={['transition-opacity duration-200', reading && board && 'opacity-60']} aria-busy={reading}>
					{#if !board}
						<ReadingReminders />
					{:else if !board.ok}
						<AutomationFailure failure={board.failure} app="Lembretes" />
					{:else}
						<ReminderLedger
							lists={board.value.lists}
							items={shown}
							list={board.value.list}
							includeCompleted={data.filter.includeCompleted}
							group={view.group}
							{query}
							{fresh}
						/>
					{/if}
				</div>
			</div>
		</div>
	{/if}
</div>
