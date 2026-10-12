<script lang="ts">
	import type { Reminder } from '@jarvis/apple';
	import { untrack } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import CaretUpDown from 'phosphor-svelte/lib/CaretUpDown';
	import CircleNotch from 'phosphor-svelte/lib/CircleNotch';
	import Plus from 'phosphor-svelte/lib/Plus';
	import type { AppleFailure } from '#lib/apple/failure.js';
	import ActionFailure from '#lib/components/apple/action-failure.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { isoDay } from '#lib/reminders/due.js';
	import ReminderReceipt from './reminder-receipt.svelte';

	type Values = { title: string; list: string; date: string; time: string; notes: string };
	type Errors = Partial<Record<'title' | 'due' | 'notes' | 'list', string>>;

	type AddResult =
		| { values: Values; errors: Errors }
		| { values: Values; failure: AppleFailure }
		| { added: { reminder: Reminder; at: number } }
		| null
		| undefined;

	let {
		lists,
		preferredList,
		result,
		titleMax,
		notesMax
	}: {
		lists: ReadonlyArray<string>;
		/** The list the page is filtered to, so a new reminder lands where the user is looking. */
		preferredList: string | null;
		result: AddResult;
		titleMax: number;
		notesMax: number;
	} = $props();

	// Seeded once from a no-JS round trip; the user owns the fields after that.
	const seed = untrack(() => (result && 'values' in result ? result.values : null));
	let title = $state(seed?.title ?? '');
	let list = $state(seed?.list ?? untrack(() => preferredList ?? ''));
	let date = $state(seed?.date ?? '');
	let time = $state(seed?.time ?? '');
	let notes = $state(seed?.notes ?? '');
	let pending = $state(false);
	let titleInput = $state<HTMLInputElement>();

	const errors = $derived<Errors>(result && 'errors' in result ? result.errors : {});
	const failure = $derived(result && 'failure' in result ? result.failure : undefined);
	const added = $derived(result && 'added' in result ? result.added : undefined);
	const ready = $derived(title.trim() !== '' && !pending);

	// A list from the URL that the Reminders app no longer has must not be sent as the target.
	const options = $derived(list !== '' && !lists.includes(list) ? [...lists, list] : lists);

	// One tap for the dates that cover most reminders; any other day goes in the date field.
	const today = isoDay(new Date());
	const presets = [
		{ label: 'Sem data', value: '' },
		{ label: 'Hoje', value: today },
		{ label: 'Amanhã', value: isoDay(new Date(), 1) },
		{ label: 'Em 7 dias', value: isoDay(new Date(), 7) }
	] as const;

	// ⌘↩ files the reminder from any field, the notes included.
	const submitShortcut = (node: HTMLFormElement) => {
		const onkeydown = (event: KeyboardEvent) => {
			if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && ready) {
				event.preventDefault();
				node.requestSubmit();
			}
		};
		node.addEventListener('keydown', onkeydown);
		return () => node.removeEventListener('keydown', onkeydown);
	};

	const submit: SubmitFunction = () => {
		pending = true;
		return async ({ result, update }) => {
			await update({ reset: false });
			if (result.type === 'success') {
				title = '';
				notes = '';
				date = '';
				time = '';
				titleInput?.focus();
			}
			pending = false;
		};
	};
</script>

<form
	method="POST"
	action="?/add"
	use:enhance={submit}
	class="grid gap-5"
	aria-labelledby="add-title"
	{@attach submitShortcut}
>
	<div class="sheet">
		<div class="flex items-baseline justify-between gap-4 border-b border-rule px-4 pt-4 pb-3">
			<h2 id="add-title" class="field-label">Novo lembrete</h2>
			<span class="flex items-center gap-1.5 text-xs text-ink-soft">
				vai para o app Lembretes
				<kbd class="key" title="Atalho: N">N</kbd>
			</span>
		</div>

		<div class="px-4 pt-1">
			<label for="reminder-title" class="sr-only">Título</label>
			<input
				bind:this={titleInput}
				id="reminder-title"
				data-bare
				name="title"
				bind:value={title}
				required
				maxlength={titleMax}
				autocomplete="off"
				placeholder="O que lembrar?"
				aria-invalid={errors.title ? 'true' : undefined}
				aria-describedby={errors.title ? 'reminder-title-error' : undefined}
				class="block h-12 w-full border-b border-rule bg-transparent text-[1.0625rem] font-medium text-ink outline-none placeholder:font-normal placeholder:text-ink-soft/80 focus-visible:border-carbon focus-visible:outline-none aria-invalid:border-alert"
			/>
			{#if errors.title}
				<p id="reminder-title-error" class="pt-1.5 text-sm font-medium text-alert">{errors.title}</p>
			{/if}

			<label for="reminder-notes" class="sr-only">Notas</label>
			<textarea
				id="reminder-notes"
				data-bare
				name="notes"
				bind:value={notes}
				rows="2"
				maxlength={notesMax}
				placeholder="Notas (opcional)"
				aria-invalid={errors.notes ? 'true' : undefined}
				aria-describedby={errors.notes ? 'reminder-notes-error' : undefined}
				class="ruled block min-h-[3.5rem] w-full resize-y bg-transparent pt-0 pb-0 text-sm text-ink outline-none [field-sizing:content] pointer-coarse:text-[1rem] placeholder:text-ink-soft/80 focus-visible:outline-none"
			></textarea>
			{#if errors.notes}
				<p id="reminder-notes-error" class="pt-1.5 text-sm font-medium text-alert">{errors.notes}</p>
			{/if}
		</div>

		<div class="grid gap-4 border-t border-rule px-4 pt-3.5 pb-4">
			<div class="grid gap-1.5">
				<label for="reminder-list" class="field-label">Lista</label>
				<div class="relative">
					<select
						id="reminder-list"
						name="list"
						bind:value={list}
						aria-invalid={errors.list ? 'true' : undefined}
						class="field-input appearance-none pr-8"
					>
						<option value="">Lista padrão do Lembretes</option>
						{#each options as name (name)}
							<option value={name}>{name}</option>
						{/each}
					</select>
					<CaretUpDown
						class="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-ink-soft"
						weight="bold"
						aria-hidden="true"
					/>
				</div>
				{#if errors.list}<p class="text-sm font-medium text-alert">{errors.list}</p>{/if}
			</div>

			<fieldset class="grid gap-2" aria-describedby="reminder-due-hint{errors.due ? ' reminder-due-error' : ''}">
				<legend class="field-label mb-1.5">Quando</legend>
				<div class="segmented" role="radiogroup" aria-label="Atalhos de data">
					{#each presets as preset (preset.label)}
						<label class="segment px-1.5 py-[0.3125rem] text-[0.8125rem]">
							<input
								type="radio"
								name="due-preset"
								class="sr-only"
								checked={date === preset.value}
								onchange={() => {
									date = preset.value;
									if (preset.value === '') time = '';
								}}
							/>
							{preset.label}
						</label>
					{/each}
				</div>
				<div class="grid grid-cols-[minmax(0,1fr)_7rem] gap-2">
					<label class="sr-only" for="reminder-date">Dia</label>
					<input
						id="reminder-date"
						type="date"
						name="date"
						bind:value={date}
						aria-invalid={errors.due ? 'true' : undefined}
						class="field-input tabular"
					/>
					<label class="sr-only" for="reminder-time">Hora</label>
					<input
						id="reminder-time"
						type="time"
						name="time"
						bind:value={time}
						disabled={date === ''}
						aria-invalid={errors.due ? 'true' : undefined}
						class="field-input tabular"
					/>
				</div>
				{#if errors.due}
					<p id="reminder-due-error" class="text-sm font-medium text-alert">{errors.due}</p>
				{:else}
					<p id="reminder-due-hint" class="text-xs text-ink-soft">
						{date === '' ? 'Opcional. Com dia e sem hora, vale o dia inteiro.' : time === '' ? 'Dia inteiro.' : 'No horário deste Mac.'}
					</p>
				{/if}
			</fieldset>

			<Button type="submit" size="lg" class="w-full" disabled={!ready} aria-busy={pending}>
				{#if pending}
					<CircleNotch class="size-4 animate-spin" weight="bold" aria-hidden="true" />
					Anotando…
				{:else}
					<Plus class="size-4" weight="bold" aria-hidden="true" />
					Anotar lembrete
					<kbd class="ml-1 font-mono text-xs font-medium opacity-60" aria-hidden="true">⌘↩</kbd>
				{/if}
			</Button>
		</div>
	</div>

	<div aria-live="polite">
		{#if failure}
			<ActionFailure {failure} app="Lembretes" nothing="Nada foi salvo." />
		{:else if added}
			{#key added.at}
				<ReminderReceipt reminder={added.reminder} at={added.at} />
			{/key}
		{/if}
	</div>
</form>

<style>
	.key {
		display: inline-grid;
		place-items: center;
		min-width: 1.25rem;
		height: 1.25rem;
		border: 1px solid var(--rule-strong);
		border-bottom-width: 2px;
		border-radius: 4px;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		line-height: 1;
		color: var(--ink-soft);
	}
</style>
