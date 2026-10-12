<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import ArrowClockwise from 'phosphor-svelte/lib/ArrowClockwise';
	import DeliveryFailure from '#lib/components/alexa/delivery-failure.svelte';
	import SpeakDesk from '#lib/components/alexa/speak-desk.svelte';
	import ModuleHeader from '#lib/components/jarvis/module-header.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { voiceName } from '#lib/alexa/voice.js';
	import { Latest } from '#lib/jarvis/latest.svelte.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// The Echo list is streamed from Amazon; the last answer stays on screen while a new one is read.
	const latest = new Latest(() => data.echoes);
	const echoes = $derived(latest.value);
	const reading = $derived(latest.pending);

	const settings = $derived(data.settings);
	const voice = $derived(data.voice);
	const speechEnabled = $derived(settings.ok ? settings.value.speechEnabled : undefined);
	const devices = $derived(echoes?.ok ? echoes.value : undefined);
	const online = $derived(devices ? devices.filter((d) => d.online).length : 0);
</script>

<svelte:head>
	<title>Voz · Jarvis</title>
</svelte:head>

<div class="mx-auto grid max-w-[72rem] gap-8">
	<ModuleHeader title="Voz">
		{#snippet summary()}
			{#if speechEnabled === false}
				Fala desativada neste servidor.
			{:else if voice.ok && voice.value.engine === 'kokoro'}
				Fala no Mac com a voz {voiceName(voice.value.voice)}, pelo Kokoro local.
			{:else if voice.ok}
				Fala no Mac com a voz do sistema; o Kokoro não respondeu.
			{:else}
				Voz do Mac sem configuração.
			{/if}
			{#if devices}
				<span class="whitespace-nowrap">
					<span class="tabular">{online}</span> de <span class="tabular">{devices.length}</span>
					{devices.length === 1 ? 'Echo online' : 'Echos online'}.
				</span>
			{:else if echoes}
				<span class="whitespace-nowrap">Echos indisponíveis.</span>
			{:else}
				<span class="whitespace-nowrap">Consultando os Echos…</span>
			{/if}
		{/snippet}
		{#snippet actions()}
			<Button variant="outline" onclick={() => refreshAll()} disabled={reading}>
				<ArrowClockwise class={['size-4', reading && 'animate-spin']} weight="bold" aria-hidden="true" />
				{reading && echoes ? 'Atualizando…' : 'Atualizar'}
			</Button>
		{/snippet}
	</ModuleHeader>

	{#if !settings.ok}
		<DeliveryFailure failure={settings.failure} />
	{:else}
		<div class={['transition-opacity duration-200', reading && echoes && 'opacity-80']} aria-busy={reading}>
			<SpeakDesk {voice} {echoes} {speechEnabled} maxLength={data.maxLength} result={form} />
		</div>
	{/if}
</div>
