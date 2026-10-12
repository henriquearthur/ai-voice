<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import DeviceMobile from 'phosphor-svelte/lib/DeviceMobile';
	import Headset from 'phosphor-svelte/lib/Headset';
	import Phone from 'phosphor-svelte/lib/Phone';
	import X from 'phosphor-svelte/lib/X';
	import ActionFailure from '#lib/components/apple/action-failure.svelte';
	import ReceiptSlip from '#lib/components/jarvis/receipt-slip.svelte';
	import { checkPhone, type CallVia, callViaLabels } from '#lib/ir/phone.js';
	import type { IrResult } from '#lib/ir/results.js';
	import CallConfirm from './call-confirm.svelte';

	let { result }: { result: IrResult } = $props();

	const mine = $derived(result?.panel === 'phone' ? result : undefined);

	// Seeded once from the last submission (no-JS round trip); the user owns the fields afterwards.
	const seed = untrack(() => (result?.panel === 'phone' ? result : undefined));
	let number = $state(seed?.number ?? '');
	let via = $state<CallVia>(seed?.via ?? 'phone');
	// While confirming, the number is read-only and the route is locked, so the confirmation always
	// matches what is on screen; "Voltar e editar" is the only way back to editing.
	let confirming = $state(seed?.review === true);
	let pending = $state(false);
	let numberInput = $state<HTMLInputElement>();

	const check = $derived(checkPhone(number));
	const touched = $derived(number.trim() !== '');
	// A half-typed number is not an error yet; it becomes one only once there is enough to judge.
	const wrong = $derived(Boolean(mine?.invalid) || (touched && !check.ok && number.replace(/\D/g, '').length > 3));
	const international = $derived(number.trim().startsWith('+'));
	const vias: { value: CallVia; icon: typeof Phone }[] = [
		{ value: 'phone', icon: DeviceMobile },
		{ value: 'facetime-audio', icon: Headset }
	];

	function clear() {
		number = '';
		numberInput?.focus();
	}

	const submit: SubmitFunction = ({ action, cancel }) => {
		if (action.search === '?/review') {
			cancel();
			if (check.ok) confirming = true;
			return;
		}
		pending = true;
		return async ({ update }) => {
			await update({ reset: false, refreshAll: false });
			confirming = false;
			pending = false;
		};
	};
</script>

<section aria-labelledby="call-title" class="grid min-w-0 content-start gap-4">
	<form method="POST" action="?/call" use:enhance={submit} class="sheet overflow-hidden">
		<header class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-rule px-4 py-2.5 sm:px-5">
			<h2 id="call-title" class="flex items-center gap-2 text-[0.9375rem] font-semibold text-ink">
				<Phone class="size-[1.125rem] text-carbon" weight="bold" aria-hidden="true" />
				Ligar
			</h2>
			{#if confirming}
				<!-- A disabled fieldset is not submitted: carry the locked route along explicitly. -->
				<input type="hidden" name="via" value={via} />
			{/if}
			<fieldset class="segmented w-full min-w-[13.5rem] sm:w-auto" disabled={confirming}>
				<legend class="sr-only">Ligar por</legend>
				{#each vias as option (option.value)}
					<label class="segment flex items-center justify-center gap-1.5 px-2.5">
						<input type="radio" name="via" value={option.value} bind:group={via} class="sr-only" />
						<option.icon class="size-4 shrink-0" weight={via === option.value ? 'fill' : 'bold'} aria-hidden="true" />
						{callViaLabels[option.value]}
					</label>
				{/each}
			</fieldset>
		</header>

		<div class="grid gap-2 px-4 pt-5 pb-6 sm:px-5">
			<div class="flex items-baseline justify-between gap-3">
				<label for="call-number" class="field-label">Número</label>
				<span class="text-xs text-ink-soft">{international ? 'Internacional' : 'Brasil · +55'}</span>
			</div>
			<div class={['dial', wrong && 'dial-wrong']}>
				<input
					id="call-number"
					name="number"
					type="tel"
					inputmode="tel"
					autocomplete="off"
					enterkeyhint="done"
					bind:this={numberInput}
					bind:value={number}
					readonly={confirming}
					onkeydown={(event) => {
						// Enter in the locked field would submit with "Sim, ligar" as the default button.
						if (confirming && event.key === 'Enter') event.preventDefault();
					}}
					required
					placeholder="11 99999-8888"
					aria-invalid={wrong ? 'true' : undefined}
					aria-describedby="call-hint{mine?.invalid ? ' call-invalid' : ''}"
					class="tabular w-0 min-w-0 flex-1 bg-transparent font-mono text-[1.625rem] leading-none tracking-[-0.01em] text-ink outline-none placeholder:text-ink-soft/55"
				/>
				{#if touched && !confirming}
					<button type="button" onclick={clear} class="dial-clear" aria-label="Apagar o número">
						<X class="size-3.5" weight="bold" aria-hidden="true" />
					</button>
				{/if}
			</div>
			<p id="call-hint" class="min-h-5 text-sm text-ink-soft" aria-live="polite">
				{#if !touched}
					DDD e número. Sem <span class="font-mono">+</span>, o Jarvis assume o Brasil.
				{:else if check.ok}
					Será discado como <span class="tabular font-mono font-semibold text-ink">{check.display}</span>
				{:else}
					<span class={wrong ? 'text-alert' : undefined}>{check.hint}</span>
				{/if}
			</p>

			{#if mine?.invalid}
				<p id="call-invalid" class="text-sm font-medium text-alert">{mine.invalid}</p>
			{/if}
		</div>

		<CallConfirm
			{confirming}
			{pending}
			ready={check.ok}
			display={check.display}
			viaLabel={callViaLabels[via]}
			oncancel={() => {
				confirming = false;
				numberInput?.focus();
			}}
		/>
	</form>

	<div aria-live="polite">
		{#if mine?.failure}
			<ActionFailure failure={mine.failure} app="FaceTime" nothing="Nenhuma ligação foi iniciada." />
		{:else if mine?.placed}
			{@const placed = mine.placed}
			{#key placed.at}
				<ReceiptSlip stamp="Entregue" at={placed.at} title="Número entregue ao macOS.">
					<p class="text-sm text-ink-soft">
						<span class="tabular font-mono text-ink">{placed.display}</span> aguarda a sua confirmação no Mac. A chamada só
						começa depois que você aceitar lá; o Jarvis não sabe se foi atendida.
					</p>
				</ReceiptSlip>
			{/key}
		{/if}
	</div>
</section>

<style>
	/* The number reads like a handset display: set large, ruled underneath, never boxed. */
	.dial {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		height: 3.5rem;
		border-bottom: 1.5px solid var(--input);
		transition: border-color 150ms;

		&:hover:not(:focus-within) {
			border-color: var(--ink-soft);
		}

		&:focus-within {
			border-color: var(--carbon);
			box-shadow: 0 1.5px 0 var(--carbon);
		}

		&:has(input[readonly]) {
			border-bottom-style: dashed;
			border-color: var(--rule-strong);
			box-shadow: none;
		}
	}

	.dial-wrong,
	.dial-wrong:focus-within {
		border-color: var(--alert);
		box-shadow: none;
	}

	.dial-clear {
		display: grid;
		place-items: center;
		width: 1.75rem;
		height: 1.75rem;
		flex-shrink: 0;
		border-radius: 999px;
		background-color: var(--paper-sunk);
		color: var(--ink-soft);
		transition-property: background-color, color, scale;
		transition-duration: 150ms;
		transition-timing-function: var(--ease-out);

		&:hover {
			background-color: var(--accent);
			color: var(--ink);
		}

		&:active {
			scale: 0.92;
		}
	}
</style>
