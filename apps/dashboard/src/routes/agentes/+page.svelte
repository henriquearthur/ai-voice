<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import { onMount } from 'svelte';
	import Robot from 'phosphor-svelte/lib/Robot';
	import ModuleHeader from '#lib/components/jarvis/module-header.svelte';
	import { ROTULO_MODO, TEXTO_MAX, type AgenteCard } from '#lib/agentes/model.js';
	import type { PageProps } from './$types';
	import './agentes.css';

	let { data, form }: PageProps = $props();

	const POLL_MS = 2000;
	const agentes = $derived<AgenteCard[]>(data.ok ? data.agentes : []);
	const bloqueados = $derived(agentes.filter((a) => a.bloqueado).length);

	// A tela só pergunta ao servidor enquanto a aba está à vista; ao voltar, atualiza na hora.
	onMount(() => {
		let timer: ReturnType<typeof setInterval> | undefined;
		const parar = () => {
			if (timer !== undefined) clearInterval(timer);
			timer = undefined;
		};
		const iniciar = () => {
			parar();
			timer = setInterval(() => void invalidate('app:agentes'), POLL_MS);
		};
		const aoMudar = () => {
			if (document.visibilityState === 'visible') {
				void invalidate('app:agentes');
				iniciar();
			} else parar();
		};
		document.addEventListener('visibilitychange', aoMudar);
		if (document.visibilityState === 'visible') iniciar();
		return () => {
			document.removeEventListener('visibilitychange', aoMudar);
			parar();
		};
	});

	let rascunhos = $state<Record<string, string>>({});
	let confirmando = $state<string | null>(null);
	let enviando = $state<string | null>(null);

	const ROTULO_ESTADO: Record<string, string> = {
		idle: 'Parado',
		working: 'Trabalhando',
		blocked: 'Pede permissão',
		done: 'Concluído',
		unknown: 'Desconhecido'
	};

	const aoEnviar = (pane: string) => () => {
		enviando = pane;
		return async ({ result, update }: { result: { type: string }; update: (o?: { reset?: boolean }) => Promise<void> }) => {
			if (result.type === 'success') {
				confirmando = null;
				rascunhos[pane] = '';
			}
			await update({ reset: false });
			enviando = null;
		};
	};

	// A cauda fica colada no fim, onde o terminal está escrevendo.
	const noFim = (el: HTMLElement, _cauda: string) => {
		el.scrollTop = el.scrollHeight;
		return { update: () => (el.scrollTop = el.scrollHeight) };
	};
</script>

<svelte:head>
	<title>Agentes · Jarvis</title>
</svelte:head>

<ModuleHeader title="Agentes" icon={Robot}>
	{#snippet summary()}
		{#if !data.ok}
			Não foi possível falar com o herdr.
		{:else if bloqueados > 0}
			{bloqueados} {bloqueados === 1 ? 'agente espera' : 'agentes esperam'} uma resposta de permissão.
		{:else}
			{agentes.length} {agentes.length === 1 ? 'agente vivo' : 'agentes vivos'}, atualizando a cada 2 s.
		{/if}
	{/snippet}
</ModuleHeader>

{#if !data.ok}
	<p class="ag-aviso" role="alert">{data.erro}</p>
{:else if agentes.length === 0}
	<p class="ag-vazio">Nenhum agente vivo no herdr.</p>
{/if}

<ul class="ag-lista">
	{#each agentes as a (a.pane)}
		{@const erro = form && 'erro' in form && form.pane === a.pane ? form.erro : null}
		<li class="ag-card" class:ag-bloqueado={a.bloqueado} data-estado={a.estado}>
			<header class="ag-topo">
				<div class="ag-nome">
					<h2>{a.nome}</h2>
					{#if a.titulo}<p class="ag-titulo">{a.titulo}</p>{/if}
				</div>
				<span class="ag-estado" data-estado={a.estado}>{ROTULO_ESTADO[a.estado]}</span>
			</header>

			{#if a.bloqueado}
				<form method="POST" action="?/acao" class="ag-decisao" use:enhance={aoEnviar(a.pane)}>
					<input type="hidden" name="pane" value={a.pane} />
					<button name="acao" value="aprovar" class="ag-botao ag-aprovar" disabled={enviando === a.pane}>Aprovar</button>
					<button name="acao" value="negar" class="ag-botao ag-negar" disabled={enviando === a.pane}>Negar</button>
				</form>
			{/if}

			<pre class="ag-cauda" use:noFim={a.cauda} aria-label="Cauda do terminal de {a.nome}">{a.cauda || 'Sem saída para mostrar.'}</pre>

			<form method="POST" action="?/acao" class="ag-steer" use:enhance={aoEnviar(a.pane)}>
				<input type="hidden" name="pane" value={a.pane} />
				<label class="sr-only" for="texto-{a.pane}">Texto para {a.nome}</label>
				<textarea
					id="texto-{a.pane}"
					name="texto"
					rows="2"
					maxlength={TEXTO_MAX}
					placeholder="Orientar {a.nome} (ctrl+enter)"
					bind:value={rascunhos[a.pane]}
					onkeydown={(e) => {
						if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
							e.preventDefault();
							e.currentTarget.form?.requestSubmit(e.currentTarget.form.querySelector('button[value=steer]'));
						}
					}}
				></textarea>
				<button name="acao" value="steer" class="ag-botao" disabled={enviando === a.pane || !(rascunhos[a.pane] ?? '').trim()}>
					Enviar
				</button>
			</form>

			<form method="POST" action="?/acao" class="ag-controles" use:enhance={aoEnviar(a.pane)}>
				<input type="hidden" name="pane" value={a.pane} />
				<button name="acao" value="modo" class="ag-botao ag-modo" disabled={enviando === a.pane || a.modo === null}>
					<span class="ag-rotulo">Modo</span>
					<strong>{a.modo ? ROTULO_MODO[a.modo] : 'sem modo'}</strong>
				</button>
				{#if confirmando === a.pane}
					<button name="acao" value="interromper" class="ag-botao ag-perigo" disabled={enviando === a.pane}>Confirmar</button>
					<button type="button" class="ag-botao" onclick={() => (confirmando = null)}>Cancelar</button>
				{:else}
					<button type="button" class="ag-botao ag-perigo-leve" onclick={() => (confirmando = a.pane)}>Interromper</button>
				{/if}
			</form>

			{#if erro}<p class="ag-aviso" role="alert">{erro}</p>{/if}
		</li>
	{/each}
</ul>
