<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { followLive } from '#lib/jarvis/live.js';
	import ArrowSquareOut from 'phosphor-svelte/lib/ArrowSquareOut';
	import CopyCommand from '#lib/components/jarvis/copy-command.svelte';
	import ModuleHeader from '#lib/components/jarvis/module-header.svelte';
	import Notice from '#lib/components/jarvis/notice.svelte';
	import HerdrAgentes from '#lib/components/telemetria/herdr-agentes.svelte';
	import Interrupcoes from '#lib/components/telemetria/interrupcoes.svelte';
	import Latencias from '#lib/components/telemetria/latencias.svelte';
	import AppWebSecao from '#lib/components/telemetria/app-web.svelte';
	import ServicosSaude from '#lib/components/telemetria/servicos-saude.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { count, duration } from '#lib/conversa/format.js';
	import { saudePeriodico, type Painel } from '#lib/telemetria/model.js';
	import type { AppWeb } from '#lib/telemetria/web/app.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// The server renders the first read; after that the page follows the collector over server-sent events.
	let painel = $state<Painel>(untrack(() => data.painel));
	let connection = $state<'conectando' | 'ao-vivo' | 'reconectando'>('conectando');
	let now = $state(untrack(() => data.painel.geradoEm));

	// At most one update a second, nothing at all while the window is hidden. The clock only feeds
	// "há 3 min" labels, so it ticks every 5 s.
	onMount(() =>
		followLive<Painel>(
			'/telemetria/ao-vivo',
			{
				onData: (value) => (painel = value),
				onStatus: (status) => (connection = status),
				onTick: (at) => (now = at)
			},
			{ tickMs: 5000 }
		)
	);

	// The "App" section changes slowly (last hour from Prometheus): one read every 15 s, only while visible.
	let app = $state<AppWeb>(untrack(() => data.app));
	onMount(() => {
		const ler = async () => {
			if (document.hidden) return;
			try {
				const res = await fetch('/telemetria/app', { headers: { accept: 'application/json' } });
				if (res.ok) app = (await res.json()) as AppWeb;
			} catch {
				// Keeps the last read.
			}
		};
		const timer = setInterval(ler, 15_000);
		const onVisibilidade = () => !document.hidden && void ler();
		document.addEventListener('visibilitychange', onVisibilidade);
		return () => {
			clearInterval(timer);
			document.removeEventListener('visibilitychange', onVisibilidade);
		};
	});

	const estado = $derived(painel.estado);
	const servicos = $derived(estado?.servicos.length ? estado.servicos : painel.servicosProm);
	// A periodic service between healthy runs counts as up: it has no process by design.
	const vivos = $derived(servicos.filter((s) => s.vivo || (s.periodico && saudePeriodico(s, now) === 'agendado')).length);
	const atencao = $derived((estado?.herdr?.agentes ?? []).filter((a) => a.estado === 'blocked').length);
	const entrega = $derived(painel.latencias.find((l) => l.id === 'escuta-entrega')?.p50 ?? estado?.escuta?.entregaMs?.p50 ?? null);
	const aoVivo = $derived(connection === 'ao-vivo' && painel.coletor === 'ok');
</script>

<svelte:head>
	<title>Telemetria · Jarvis</title>
</svelte:head>

<div class="mx-auto grid max-w-[72rem] grid-cols-[minmax(0,1fr)] gap-8">
	<ModuleHeader title="Telemetria">
		{#snippet summary()}
			{#if !estado && servicos.length === 0}
				Sem leitura do coletor agora.
			{:else}
				<span class="whitespace-nowrap"><span class="tabular">{vivos}</span> de <span class="tabular">{servicos.length}</span> serviços no ar.</span>
				{#if atencao > 0}
					<span class="whitespace-nowrap"><span class="tabular">{count(atencao)}</span> {atencao === 1 ? 'agente esperando' : 'agentes esperando'} você.</span>
				{/if}
				{#if entrega !== null}
					<span class="whitespace-nowrap">Pedidos entregues em <span class="tabular">{duration(entrega)}</span> (p50).</span>
				{/if}
			{/if}
		{/snippet}
		{#snippet actions()}
			<p
				class={[
					'flex shrink-0 items-center gap-2 rounded-full border px-2.5 py-1 text-micro font-semibold',
					aoVivo ? 'border-rule bg-sunken text-ink-soft' : 'border-caution/30 bg-caution-soft text-caution'
				]}
				aria-live="polite"
			>
				<span class={['size-1.5 rounded-full', aoVivo ? 'bg-positive' : 'bg-caution']} aria-hidden="true"></span>
				{#if connection === 'conectando'}Conectando…{:else if connection === 'reconectando'}Reconectando…{:else if painel.coletor === 'fora'}Coletor fora{:else}Ao vivo{/if}
			</p>
			<Button variant="outline" href={painel.painelUrl} target="_blank" rel="noopener noreferrer">
				Abrir painel completo
				<ArrowSquareOut class="size-4" weight="bold" aria-hidden="true" />
			</Button>
		{/snippet}
	</ModuleHeader>

	{#if painel.coletor === 'fora'}
		<Notice tone="info" title="O coletor ao vivo não está respondendo">
			<p>
				Esta aba lê <code>{painel.coletorUrl}/estado</code>. Assim que ele subir, os serviços, os agentes e as interrupções
				aparecem aqui sozinhos, sem recarregar. O histórico continua no painel completo.
			</p>
			<div class="mt-2.5"><CopyCommand command="curl -s {painel.coletorUrl}/estado" /></div>
		</Notice>
	{/if}

	<ServicosSaude {servicos} {now} fonte={estado?.servicos.length ? 'ao-vivo' : 'prometheus'} />

	<div class="grid items-start gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] xl:gap-x-12">
		<div class="grid min-w-0 gap-8">
			<HerdrAgentes herdr={estado?.herdr ?? null} historico={painel.historico} {now} />
		</div>
		<aside class="grid min-w-0 gap-6 lg:sticky lg:top-10" aria-label="Voz, escuta e app">
			<Latencias latencias={painel.latencias} prometheus={painel.prometheus} entregaColetor={estado?.escuta?.entregaMs ?? null} />
			<Interrupcoes escuta={estado?.escuta ?? null} {now} />
			<AppWebSecao {app} />
		</aside>
	</div>
</div>
