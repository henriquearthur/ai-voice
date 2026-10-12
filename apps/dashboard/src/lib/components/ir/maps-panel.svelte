<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import ArrowRight from 'phosphor-svelte/lib/ArrowRight';
	import ArrowSquareOut from 'phosphor-svelte/lib/ArrowSquareOut';
	import ArrowsDownUp from 'phosphor-svelte/lib/ArrowsDownUp';
	import Bus from 'phosphor-svelte/lib/Bus';
	import Car from 'phosphor-svelte/lib/Car';
	import CircleNotch from 'phosphor-svelte/lib/CircleNotch';
	import MagnifyingGlass from 'phosphor-svelte/lib/MagnifyingGlass';
	import MapTrifold from 'phosphor-svelte/lib/MapTrifold';
	import PersonSimpleWalk from 'phosphor-svelte/lib/PersonSimpleWalk';
	import ActionFailure from '#lib/components/apple/action-failure.svelte';
	import CopyButton from '#lib/components/jarvis/copy-button.svelte';
	import ReceiptSlip from '#lib/components/jarvis/receipt-slip.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { type MapsMode, mapsModeLabels } from '#lib/ir/maps.js';
	import type { IrResult } from '#lib/ir/results.js';

	let { result }: { result: IrResult } = $props();

	const mine = $derived(result?.panel === 'maps' ? result : undefined);

	// Seeded once from the last submission (no-JS round trip); the user owns the fields afterwards.
	const seed = untrack(() => (result?.panel === 'maps' ? result : undefined));
	let kind = $state<'search' | 'directions'>(seed?.kind ?? 'search');
	let query = $state(seed?.query ?? '');
	let to = $state(seed?.to ?? '');
	let from = $state(seed?.from ?? '');
	let mode = $state<MapsMode>(seed?.mode ?? 'driving');
	let pending = $state(false);
	let flipped = $state(false);

	const kinds = [
		{ value: 'search', label: 'Buscar' },
		{ value: 'directions', label: 'Rota' }
	] as const;

	const modes = [
		{ value: 'driving', icon: Car },
		{ value: 'walking', icon: PersonSimpleWalk },
		{ value: 'transit', icon: Bus }
	] as const;

	const ready = $derived((kind === 'search' ? query.trim() : to.trim()) !== '' && !pending);
	const invalid = $derived(mine?.invalid);

	// Switching between search and route carries the place along, so "Buscar" → "Rota" is one click, not a retype.
	function carry() {
		if (kind === 'directions' && to.trim() === '') to = query;
		if (kind === 'search' && query.trim() === '') query = to;
	}

	function swap() {
		[from, to] = [to, from];
		flipped = !flipped;
	}

	const submit: SubmitFunction = () => {
		pending = true;
		return async ({ update }) => {
			await update({ reset: false, refreshAll: false });
			pending = false;
		};
	};
</script>

<section aria-labelledby="maps-title" class="grid min-w-0 content-start gap-4">
	<form method="POST" action="?/{kind}" use:enhance={submit} class="sheet overflow-hidden">
		<header class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-rule px-4 py-2.5 sm:px-5">
			<h2 id="maps-title" class="flex items-center gap-2 text-[0.9375rem] font-semibold text-ink">
				<MapTrifold class="size-[1.125rem] text-carbon" weight="bold" aria-hidden="true" />
				Mapas
			</h2>
			<fieldset class="segmented min-w-[11rem]">
				<legend class="sr-only">Tipo de pedido</legend>
				{#each kinds as option (option.value)}
					<label class="segment">
						<input type="radio" name="kind" value={option.value} bind:group={kind} onchange={carry} class="sr-only" />
						{option.label}
					</label>
				{/each}
			</fieldset>
		</header>

		<div class="grid gap-5 px-4 pt-5 pb-6 sm:px-5">
			{#if kind === 'search'}
				<div class="grid gap-2">
					<label for="maps-query" class="field-label">Lugar ou endereço</label>
					<div class="relative">
						<MagnifyingGlass
							class="pointer-events-none absolute top-1/2 left-3.5 size-[1.125rem] -translate-y-1/2 text-ink-soft"
							weight="bold"
							aria-hidden="true"
						/>
						<input
							id="maps-query"
							name="query"
							bind:value={query}
							required
							maxlength="500"
							autocomplete="off"
							enterkeyhint="search"
							placeholder="Padaria perto do Ibirapuera"
							aria-invalid={invalid ? 'true' : undefined}
							aria-describedby={invalid ? 'maps-invalid' : undefined}
							class="field-input h-12 pl-10 text-base"
						/>
					</div>
				</div>
			{:else}
				<div class="grid gap-2">
					<span id="maps-route-label" class="field-label">Trajeto</span>
					<div role="group" aria-labelledby="maps-route-label" class="itinerary">
						<div class="stop">
							<span class="mark mark-from" aria-hidden="true"></span>
							<label for="maps-from" class="stop-label">De<span class="sr-only">, partida opcional</span></label>
							<input
								id="maps-from"
								name="from"
								bind:value={from}
								maxlength="500"
								autocomplete="off"
								enterkeyhint="next"
								placeholder="Local atual"
								class="stop-input"
							/>
						</div>
						<div class="stop">
							<span class="mark mark-to" aria-hidden="true"></span>
							<label for="maps-to" class="stop-label">Para</label>
							<input
								id="maps-to"
								name="to"
								bind:value={to}
								required
								maxlength="500"
								autocomplete="off"
								enterkeyhint="go"
								placeholder="Aeroporto de Congonhas"
								aria-invalid={invalid ? 'true' : undefined}
								aria-describedby={invalid ? 'maps-invalid' : undefined}
								class="stop-input"
							/>
						</div>
						<button
							type="button"
							onclick={swap}
							disabled={from.trim() === '' && to.trim() === ''}
							class="swap"
							aria-label="Inverter partida e destino"
							title="Inverter partida e destino"
						>
							<ArrowsDownUp class={['size-4 transition-transform duration-200', flipped && 'rotate-180']} weight="bold" aria-hidden="true" />
						</button>
					</div>
				</div>

				<fieldset class="grid gap-2">
					<legend class="field-label mb-2">Como ir</legend>
					<div class="segmented">
						{#each modes as option (option.value)}
							<label class="segment flex items-center justify-center gap-1.5 px-2">
								<input type="radio" name="mode" value={option.value} bind:group={mode} class="sr-only" />
								<option.icon class="size-4 shrink-0" weight={mode === option.value ? 'fill' : 'bold'} aria-hidden="true" />
								{mapsModeLabels[option.value]}
							</label>
						{/each}
					</div>
				</fieldset>
			{/if}

			{#if invalid}
				<p id="maps-invalid" class="-mt-2 text-sm font-medium text-alert">{invalid}</p>
			{/if}
		</div>

		<footer class="flex flex-col-reverse gap-3 border-t border-rule bg-paper-sunk px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
			<p class="text-xs text-pretty text-ink-soft">Abre no Mapas deste Mac e devolve o link para outro aparelho.</p>
			<Button type="submit" size="lg" class="w-full shrink-0 sm:w-auto" disabled={!ready} aria-busy={pending}>
				{#if pending}
					<CircleNotch class="size-4 animate-spin" weight="bold" aria-hidden="true" />
					Abrindo o Mapas…
				{:else}
					{kind === 'search' ? 'Buscar no Mapas' : 'Traçar rota'}
					<ArrowRight class="size-4" weight="bold" aria-hidden="true" />
				{/if}
			</Button>
		</footer>
	</form>

	<div aria-live="polite">
		{#if mine?.failure}
			<ActionFailure failure={mine.failure} app="Mapas" nothing="O Mapas não foi aberto." />
		{:else if mine?.opened}
			{@const opened = mine.opened}
			{#key opened.at}
				<ReceiptSlip
					stamp="Aberto"
					at={opened.at}
					title={mine.kind === 'search' ? 'Busca aberta no Mapas do Mac.' : 'Rota aberta no Mapas do Mac.'}
				>
					<p class="-mt-1 min-w-0 text-sm text-ink">
						{#if mine.kind === 'search'}
							<span class="text-ink-soft">Busca:</span> <span class="break-words">{mine.query}</span>
						{:else}
							<span class="break-words">{mine.from || 'Local atual'}</span>
							<ArrowRight class="mx-1 inline size-3.5 align-[-0.125em] text-ink-soft" weight="bold" aria-label="até" />
							<span class="break-words">{mine.to}</span>
							<span class="text-ink-soft">· {mapsModeLabels[mine.mode ?? 'driving']}</span>
						{/if}
					</p>
					<div class="flex items-stretch overflow-hidden rounded-md border border-rule-strong bg-paper">
						<a
							href={opened.url}
							target="_blank"
							rel="noreferrer"
							class="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 font-mono text-[0.8125rem] text-carbon underline-offset-4 hover:underline"
						>
							<ArrowSquareOut class="size-4 shrink-0" weight="bold" aria-hidden="true" />
							<span class="truncate">{opened.url}</span>
							<span class="sr-only">(abre em nova aba)</span>
						</a>
						<CopyButton text={opened.url} announce="Link copiado" />
					</div>
				</ReceiptSlip>
			{/key}
		{/if}
	</div>
</section>

<style>
	/*
	 * The route written as a transit itinerary: two stops on one card, a dotted rail between their
	 * marks, and the swap control sitting on the seam. The card, not each field, carries focus.
	 */
	.itinerary {
		position: relative;
		display: grid;
		border: 1px solid var(--input);
		border-radius: var(--radius);
		background-color: var(--paper);
		transition-property: border-color, box-shadow;
		transition-duration: 150ms;

		&::before {
			content: '';
			position: absolute;
			left: calc(1.125rem - 0.75px);
			top: calc(1.5rem + 7px);
			bottom: calc(1.5rem + 7px);
			border-left: 1.5px dotted var(--ink-soft);
		}

		&:hover:not(:focus-within) {
			border-color: var(--ink-soft);
		}

		&:focus-within {
			border-color: var(--carbon);
			box-shadow: 0 0 0 3px color-mix(in oklch, var(--carbon) 22%, transparent);
		}

		&:has([aria-invalid='true']) {
			border-color: var(--alert);
		}
	}

	.stop {
		display: grid;
		grid-template-columns: 2.25rem 2.75rem minmax(0, 1fr);
		align-items: center;
		height: 3rem;
		padding-right: 3.25rem;

		& + & {
			border-top: 1px solid var(--rule);
		}
	}

	.mark {
		justify-self: center;
		width: 0.625rem;
		height: 0.625rem;
		border-radius: 999px;
		position: relative;
		z-index: 1;
	}

	.mark-from {
		border: 2px solid var(--carbon);
		background-color: var(--paper);
	}

	.mark-to {
		border-radius: 2px;
		background-color: var(--ink);
		box-shadow: 0 0 0 3px var(--paper);
	}

	.stop-label {
		font-stretch: 78%;
		font-weight: 600;
		font-size: 0.75rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--ink-soft);
	}

	.stop-input {
		height: 100%;
		width: 100%;
		min-width: 0;
		background: transparent;
		font-size: 1rem;
		color: var(--ink);
		outline: none;

		&::placeholder {
			color: color-mix(in oklch, var(--ink-soft) 85%, transparent);
		}
	}

	.swap {
		position: absolute;
		right: 0.625rem;
		top: 50%;
		translate: 0 -50%;
		display: grid;
		place-items: center;
		width: 2.25rem;
		height: 2.25rem;
		border: 1px solid var(--rule-strong);
		border-radius: 999px;
		background-color: var(--paper);
		color: var(--carbon);
		transition-property: background-color, color, scale, opacity;
		transition-duration: 150ms;
		transition-timing-function: var(--ease-out);

		&:hover:not(:disabled) {
			background-color: var(--accent);
		}

		&:active:not(:disabled) {
			scale: 0.94;
		}

		&:disabled {
			color: var(--ink-soft);
			opacity: 0.55;
			cursor: not-allowed;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.swap :global(svg) {
			transition: none;
		}
	}
</style>
