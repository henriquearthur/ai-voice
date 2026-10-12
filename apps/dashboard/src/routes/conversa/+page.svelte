<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { followLive } from '#lib/jarvis/live.js';
	import ConversationTimeline from '#lib/components/conversa/conversation-timeline.svelte';
	import EscutaHealth from '#lib/components/conversa/escuta-health.svelte';
	import HeardIgnored from '#lib/components/conversa/heard-ignored.svelte';
	import VoiceStage, { type Connection, type ControlFeedback } from '#lib/components/conversa/voice-stage.svelte';
	import CopyCommand from '#lib/components/jarvis/copy-command.svelte';
	import ModuleHeader from '#lib/components/jarvis/module-header.svelte';
	import Notice from '#lib/components/jarvis/notice.svelte';
	import { count, duration } from '#lib/conversa/format.js';
	import { medianLatency, phaseAt, type Snapshot } from '#lib/conversa/model.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// The server renders the first snapshot; after that the page follows the escuta over server-sent events.
	let snapshot = $state<Snapshot>(untrack(() => data.snapshot));
	let connection = $state<Connection>('conectando');
	let feedback = $state<ControlFeedback>(null);
	// Windows (Jarvis heard, request delivered) close by time alone, so the phase is recomputed every second.
	let now = $state(untrack(() => data.snapshot.generatedAt));

	// At most one update a second, nothing at all while the window is hidden.
	onMount(() =>
		followLive<Snapshot>('/conversa/ao-vivo', {
			onData: (value) => (snapshot = value),
			onStatus: (status) => (connection = status),
			onTick: (at) => (now = at)
		})
	);

	// A control's message fades away on its own once the state on screen has caught up.
	$effect(() => {
		if (!feedback) return;
		const timer = setTimeout(() => (feedback = null), feedback.failed ? 12_000 : 6000);
		return () => clearTimeout(timer);
	});

	const phase = $derived(phaseAt(snapshot, now));
	const today = $derived.by(() => {
		const midnight = new Date(now);
		midnight.setHours(0, 0, 0, 0);
		return snapshot.turns.filter((t) => t.kind === 'pedido' && t.at >= midnight.getTime());
	});
	const median = $derived(medianLatency(today));
</script>

<svelte:head>
	<title>Conversa · Jarvis</title>
</svelte:head>

<div class="mx-auto grid max-w-[72rem] gap-8">
	<ModuleHeader title="Conversa">
		{#snippet summary()}
			Diga “Jarvis” e o pedido; ele responde falando.
			{#if today.length > 0}
				<span class="whitespace-nowrap">
					<span class="tabular">{count(today.length)}</span>
					{today.length === 1 ? 'pedido hoje' : 'pedidos hoje'}{median !== null ? ',' : '.'}
				</span>
				{#if median !== null}
					<span class="whitespace-nowrap">entregues em <span class="tabular">{duration(median)}</span> (mediana).</span>
				{/if}
			{:else}
				Nenhum pedido hoje.
			{/if}
		{/snippet}
	</ModuleHeader>

	{#if !snapshot.installed}
		<Notice tone="caution" title="A escuta não está instalada neste Mac">
			<p>Sem ela não há o que ouvir. Instale e carregue o LaunchAgent a partir da raiz do repositório:</p>
			<div class="mt-2.5"><CopyCommand command="apps/escuta/scripts/instalar.sh --carregar" /></div>
		</Notice>
	{/if}

	<div class="grid items-start gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,21rem)] xl:gap-x-12">
		<div class="grid min-w-0 gap-8">
			<VoiceStage {phase} {snapshot} {connection} bind:feedback />
			<ConversationTimeline turns={snapshot.turns} {phase} {now} />
		</div>
		<aside class="grid min-w-0 gap-6 lg:sticky lg:top-10" aria-label="Detalhes da escuta">
			<EscutaHealth {snapshot} {now} />
			<HeardIgnored ignored={snapshot.ignored} noise={snapshot.noise} />
		</aside>
	</div>
</div>
