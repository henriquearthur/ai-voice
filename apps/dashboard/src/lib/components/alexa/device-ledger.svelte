<script lang="ts">
	import type { Echo } from '@jarvis/alexa';
	import { RadioGroup } from 'bits-ui';
	import { refreshAll } from '$app/navigation';
	import ArrowClockwise from 'phosphor-svelte/lib/ArrowClockwise';
	import type { MacVoiceStatus, Outcome } from '#lib/alexa/failure.js';
	import { voiceName } from '#lib/alexa/voice.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import SessionMissing from './session-missing.svelte';
	import SpeakingBars from './speaking-bars.svelte';

	/**
	 * Where the sentence leaves from. The Mac is the default and gets the room; the Echos are an
	 * optional second route, read from Amazon in the background and allowed to fail on their own.
	 */
	let {
		voice,
		echoes,
		value = $bindable('mac'),
		speaking = false,
		name = 'device'
	}: {
		voice: Outcome<MacVoiceStatus>;
		/** Undefined while Amazon has not answered yet. */
		echoes?: Outcome<ReadonlyArray<Echo>>;
		value?: string;
		speaking?: boolean;
		name?: string;
	} = $props();

	const devices = $derived(echoes?.ok ? echoes.value : undefined);
	const online = $derived(devices?.filter((d) => d.online).length ?? 0);

	let retrying = $state(false);
	async function retry() {
		retrying = true;
		await refreshAll().finally(() => (retrying = false));
	}
</script>

<fieldset class="ledger min-w-0">
	<legend class="field-label mb-2.5">Sai por</legend>

	<RadioGroup.Root bind:value {name} required class="grid gap-5">
		<!-- The default route: this Mac, on whatever output macOS is using (AirPods or the speakers). -->
		<RadioGroup.Item
			value="mac"
			class="route mac group/route relative grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 rounded-md border px-4 py-3.5 text-left"
		>
			{#snippet children({ checked })}
				{@render dot(checked)}
				<span class="min-w-0">
					<span class="flex items-center gap-2">
						<span class="text-[1.0625rem] leading-tight font-semibold text-ink">Este Mac</span>
						<SpeakingBars active={speaking} class={['text-[0.9375rem]', speaking ? 'text-carbon' : 'text-ink-soft/70']} />
					</span>
					<span class="mt-1 block text-[0.8125rem] text-ink-soft">AirPods ou alto-falante, o que estiver ativo no macOS</span>

					{#if voice.ok}
						<span class="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem]">
							<span class={['size-1.5 shrink-0 rounded-full', voice.value.engine === 'kokoro' ? 'bg-signal' : 'bg-caution']}></span>
							{#if voice.value.engine === 'kokoro'}
								<span class="font-medium text-ink">Voz {voiceName(voice.value.voice)}</span>
								<span class="text-ink-soft">Kokoro local, pronto</span>
							{:else}
								<span class="font-medium text-ink">Voz {voice.value.voice}</span>
								<span class="text-ink-soft">Kokoro fora do ar, usa a voz do sistema</span>
							{/if}
						</span>
					{:else}
						<span class="mt-2.5 block text-[0.8125rem] text-alert">Não deu para ler a configuração de voz.</span>
					{/if}
				</span>
				<span class="stamp-mark mt-0.5">Padrão</span>
			{/snippet}
		</RadioGroup.Item>

		<section aria-labelledby="echo-heading" class="min-w-0">
			<div class="mb-1.5 flex items-baseline justify-between gap-3 border-b border-rule pb-2">
				<h3 id="echo-heading" class="flex items-baseline gap-2">
					<span class="field-label">Echo</span>
					<span class="text-xs text-ink-soft">opcional, via Alexa</span>
				</h3>
				{#if devices && devices.length > 0}
					<span class="tabular text-xs text-ink-soft">
						{online} de {devices.length} online
					</span>
				{/if}
			</div>

			{#if !echoes}
				<div aria-busy="true">
					<p class="sr-only" role="status">Consultando os Echos na Amazon…</p>
					<div aria-hidden="true" class="divide-y divide-rule">
						{#each { length: 2 }, row (row)}
							<div class="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 px-1 py-2.5">
								<Skeleton class="size-4 rounded-full" />
								<Skeleton class={['h-3.5', row === 0 ? 'w-3/5' : 'w-2/5']} />
								<Skeleton class="h-3 w-12" />
							</div>
						{/each}
					</div>
				</div>
			{:else if !echoes.ok && echoes.failure.kind === 'session'}
				<SessionMissing message={echoes.failure.message} />
			{:else if !echoes.ok}
				<div class="grid gap-2 py-2.5 text-[0.8125rem]" role="status">
					<p class="text-ink">A Amazon não respondeu com a lista de Echos.</p>
					<p class="text-ink-soft">O Mac continua falando normalmente. Resposta: {echoes.failure.message}</p>
					<button type="button" class="text-action justify-self-start" onclick={retry} disabled={retrying}>
						<ArrowClockwise class={['size-3.5', retrying && 'animate-spin']} weight="bold" aria-hidden="true" />
						{retrying ? 'Consultando…' : 'Tentar de novo'}
					</button>
				</div>
			{:else if echoes.value.length === 0}
				<p class="py-2.5 text-[0.8125rem] text-ink-soft">
					Nenhum Echo nesta conta da Amazon. O Mac continua sendo a saída.
				</p>
			{:else}
				<div class="divide-y divide-rule">
					{#each echoes.value as device (device.serial)}
						<RadioGroup.Item
							value={device.serial}
							disabled={!device.online}
							class="route echo group/route relative grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 rounded-sm px-1 py-2.5 text-left"
						>
							{#snippet children({ checked })}
								{@render dot(checked)}
								<span class="min-w-0">
									<span class="flex items-baseline gap-2">
										<span class={['truncate text-sm font-semibold', device.online ? 'text-ink' : 'text-ink-soft']}>
											{device.name}
										</span>
										{#if device.isDefault}
											<span class="shrink-0 text-[0.6875rem] font-medium text-carbon">Echo padrão</span>
										{/if}
									</span>
									<span class="tabular block truncate font-mono text-[0.6875rem] text-ink-soft">{device.serial}</span>
								</span>
								<span class={['flex items-center gap-1.5 text-xs', device.online ? 'text-signal' : 'text-ink-soft']}>
									<span
										class={[
											'size-1.5 rounded-full',
											device.online ? 'bg-signal' : 'border border-ink-soft/70 bg-transparent'
										]}
									></span>
									{device.online ? 'Online' : 'Offline'}
								</span>
							{/snippet}
						</RadioGroup.Item>
					{/each}
				</div>
			{/if}
		</section>
	</RadioGroup.Root>
</fieldset>

{#snippet dot(checked: boolean)}
	<span
		aria-hidden="true"
		class={[
			'radio mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border-[1.5px]',
			checked ? 'border-ink' : 'border-input group-disabled/route:border-dashed group-disabled/route:border-rule-strong'
		]}
	>
		<span class={['size-[7px] rounded-full bg-ink', checked ? 'scale-100 opacity-100' : 'scale-50 opacity-0']}></span>
	</span>
{/snippet}

<style>
	.ledger :global(.route) {
		transition-property: background-color, border-color, box-shadow;
		transition-duration: 150ms;
		transition-timing-function: ease;
	}

	.ledger :global(.route:focus-visible) {
		z-index: 1;
	}

	.ledger :global(.route .radio),
	.ledger :global(.route .radio > span) {
		transition:
			border-color 150ms ease,
			scale 200ms var(--ease-out),
			opacity 200ms var(--ease-out);
	}

	/* The Mac route is a raised slip of its own; picked, it takes the ink edge of a filled form. */
	.ledger :global(.route.mac) {
		border-color: var(--rule);
		background-color: var(--paper);
	}

	.ledger :global(.route.mac[data-state='checked']) {
		border-color: var(--ink);
		box-shadow:
			inset 0 0 0 1px var(--ink),
			0 10px 28px -22px color-mix(in oklch, var(--ink) 55%, transparent);
	}

	.ledger :global(.route.echo[data-state='checked']) {
		background-color: var(--accent);
	}

	.ledger :global(.route:disabled) {
		cursor: not-allowed;
	}

	@media (hover: hover) and (pointer: fine) {
		.ledger :global(.route.mac[data-state='unchecked']:hover) {
			border-color: var(--rule-strong);
		}
		.ledger :global(.route.echo:not(:disabled)[data-state='unchecked']:hover) {
			background-color: color-mix(in oklch, var(--accent) 60%, transparent);
		}
	}

	/* Vermilion is stamp ink: the one default route wears it, nothing else on the rail does. */
	.stamp-mark {
		rotate: -3deg;
		border: 1.5px solid var(--stamp);
		border-radius: 3px;
		padding: 1px 6px;
		font-size: 0.625rem;
		font-weight: 700;
		font-stretch: 85%;
		line-height: 1.3;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--stamp);
	}

	.text-action {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		border-radius: 3px;
		font-weight: 600;
		color: var(--carbon);
		text-decoration: underline;
		text-decoration-color: color-mix(in oklch, var(--carbon) 40%, transparent);
		text-underline-offset: 3px;
		transition: text-decoration-color 150ms ease;
	}

	.text-action:hover:not(:disabled) {
		text-decoration-color: currentColor;
	}

	.text-action:disabled {
		cursor: progress;
		opacity: 0.7;
	}
</style>
