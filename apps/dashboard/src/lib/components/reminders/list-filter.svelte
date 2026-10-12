<script lang="ts">
	import MagnifyingGlass from 'phosphor-svelte/lib/MagnifyingGlass';
	import X from 'phosphor-svelte/lib/X';
	import FilterChip from '#lib/components/jarvis/filter-chip.svelte';
	import { viewHref, type Grouping, type View } from '#lib/reminders/view.js';

	let {
		lists,
		view,
		query = $bindable(''),
		shown,
		total
	}: {
		lists: ReadonlyArray<string>;
		view: View;
		/** Narrows what is already on screen; never goes to the server. */
		query?: string;
		shown: number;
		total: number;
	} = $props();

	const groupings: ReadonlyArray<{ value: Grouping; label: string }> = [
		{ value: 'prazo', label: 'Por prazo' },
		{ value: 'lista', label: 'Por lista' }
	];
</script>

<div class="grid gap-3">
	<div class="flex flex-wrap items-center gap-2">
		<div class="relative min-w-[12rem] flex-1">
			<label for="reminder-search" class="sr-only">Buscar nos lembretes</label>
			<MagnifyingGlass
				class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-soft"
				weight="bold"
				aria-hidden="true"
			/>
			<input
				id="reminder-search"
				type="search"
				bind:value={query}
				autocomplete="off"
				spellcheck="false"
				placeholder="Buscar título, nota ou lista"
				aria-describedby="reminder-search-count"
				onkeydown={(event) => {
					if (event.key === 'Escape' && query !== '') {
						event.preventDefault();
						query = '';
					}
				}}
				class="field-input search pr-16 pl-9"
			/>
			<div class="absolute inset-y-0 right-1.5 flex items-center">
				{#if query !== ''}
					<button
						type="button"
						onclick={() => (query = '')}
						class="clear grid size-7 place-items-center rounded-sm text-ink-soft hover:text-ink"
						aria-label="Limpar busca"
					>
						<X class="size-3.5" weight="bold" aria-hidden="true" />
					</button>
				{:else}
					<kbd class="key" aria-hidden="true">/</kbd>
				{/if}
			</div>
		</div>

		<nav aria-label="Agrupar" class="segmented w-auto shrink-0">
			{#each groupings as option (option.value)}
				<a
					href={viewHref({ ...view, group: option.value })}
					data-sveltekit-reset="false"
					data-sveltekit-replacestate
					aria-current={view.group === option.value ? 'page' : undefined}
					class="segment py-[0.3125rem] text-[0.8125rem]">{option.label}</a
				>
			{/each}
		</nav>

		<a
			href={viewHref({ ...view, includeCompleted: !view.includeCompleted })}
			data-sveltekit-reset="false"
			role="switch"
			aria-checked={view.includeCompleted}
			onkeydown={(event) => {
				// A switch answers to Space; the link underneath only knows Enter.
				if (event.key === ' ') {
					event.preventDefault();
					event.currentTarget.click();
				}
			}}
			class="toggle inline-flex h-10 shrink-0 items-center gap-2.5 rounded-md px-2.5 text-[0.8125rem] font-semibold text-ink-soft hover:text-ink"
		>
			<span aria-hidden="true" class="track"><span class="thumb"></span></span>
			Concluídos
		</a>
	</div>

	<div class="flex items-center justify-between gap-4">
		<nav aria-label="Filtrar por lista" class="chips -mx-1 min-w-0 overflow-x-auto px-1 py-0.5">
			<ul class="flex gap-1.5">
				{#each [null, ...lists] as name (name ?? '')}
					<li>
						<FilterChip href={viewHref({ ...view, list: name })} current={name === view.list}>{name ?? 'Todas'}</FilterChip>
					</li>
				{/each}
			</ul>
		</nav>
		<p id="reminder-search-count" class="tabular shrink-0 font-mono text-xs text-ink-soft" aria-live="polite">
			{#if query.trim() !== ''}
				{shown} de {total}
			{:else}
				{total} {total === 1 ? 'item' : 'itens'}
			{/if}
		</p>
	</div>
</div>

<style>
	/* The native clear glyph would sit under our own; the field draws one in the product's stroke. */
	.search::-webkit-search-cancel-button {
		appearance: none;
	}

	.key {
		display: grid;
		place-items: center;
		min-width: 1.375rem;
		height: 1.375rem;
		margin-right: 0.25rem;
		border: 1px solid var(--rule-strong);
		border-bottom-width: 2px;
		border-radius: 4px;
		font-size: 0.6875rem;
		line-height: 1;
		color: var(--ink-soft);
	}

	.clear {
		transition: color 150ms ease;
	}

	.chips {
		scrollbar-width: none;
		mask-image: linear-gradient(to right, black calc(100% - 1.5rem), transparent);
	}

	.toggle {
		transition: color 150ms ease;
	}

	.toggle:active .track {
		scale: 0.94;
	}

	.track {
		position: relative;
		display: block;
		width: 1.875rem;
		height: 1.125rem;
		border: 1px solid var(--input);
		border-radius: 999px;
		background-color: var(--paper-sunk);
		transition:
			background-color 180ms var(--ease-out),
			border-color 180ms var(--ease-out),
			scale 120ms var(--ease-out);
	}

	.thumb {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 0.75rem;
		height: 0.75rem;
		border-radius: 999px;
		background-color: var(--ink-soft);
		transition:
			translate 220ms var(--ease-out),
			background-color 180ms var(--ease-out);
	}

	.toggle[aria-checked='true'] {
		color: var(--ink);
	}

	.toggle[aria-checked='true'] .track {
		border-color: var(--ink);
		background-color: var(--ink);
	}

	.toggle[aria-checked='true'] .thumb {
		translate: 0.75rem 0;
		background-color: var(--paper);
	}
</style>
