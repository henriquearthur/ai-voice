<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import { onMount } from 'svelte';
	import Kanban from 'phosphor-svelte/lib/Kanban';
	import ModuleHeader from '#lib/components/jarvis/module-header.svelte';
	import { BRIEF_MAX, ESTADOS, KIT_MAX, ROTULO_ESTADO, TITULO_MAX } from './model.js';
	import type { PageProps } from './$types';
	import './quadro.css';

	let { data, form }: PageProps = $props();

	const POLL_MS = 5000;
	let agora = $state(Date.now());
	let enviando = $state(false);

	const porEstado = $derived(Object.fromEntries(ESTADOS.map((e) => [e, data.cards.filter((c) => c.estado === e)])));
	const abertos = $derived(data.cards.filter((c) => c.estado === 'aberto' || c.estado === 'pego').length);

	onMount(() => {
		let timer: ReturnType<typeof setInterval> | undefined;
		const parar = () => {
			if (timer !== undefined) clearInterval(timer);
			timer = undefined;
		};
		const iniciar = () => {
			parar();
			timer = setInterval(() => {
				agora = Date.now();
				void invalidate('app:quadro');
			}, POLL_MS);
		};
		const aoMudar = () => {
			if (document.visibilityState === 'visible') {
				agora = Date.now();
				void invalidate('app:quadro');
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

	const duracao = (ms: number) => {
		const s = Math.round(Math.abs(ms) / 1000);
		if (s < 60) return `${s} s`;
		if (s < 3600) return `${Math.floor(s / 60)} min`;
		return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
	};
	const hora = (ts: number) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
	const lease = (ate: number | null) => (ate === null ? null : ate >= agora ? { txt: `lease ${duracao(ate - agora)}`, vencido: false } : { txt: `lease vencido há ${duracao(agora - ate)}`, vencido: true });

	const aoCriar = () => {
		enviando = true;
		return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update();
			enviando = false;
		};
	};
</script>

<svelte:head>
	<title>Quadro · Jarvis</title>
</svelte:head>

<ModuleHeader title="Quadro" icon={Kanban}>
	{#snippet summary()}
		{#if !data.existe}
			O quadro ainda está vazio. Crie o primeiro pedido.
		{:else}
			{abertos} em andamento, {data.cards.length} no total, atualizando a cada 5 s.
		{/if}
	{/snippet}
</ModuleHeader>

<form method="POST" action="?/criar" class="qd-novo" use:enhance={aoCriar}>
	<h2>Novo pedido</h2>
	<label class="sr-only" for="qd-titulo">Título</label>
	<input id="qd-titulo" name="titulo" required maxlength={TITULO_MAX} placeholder="Título" />
	<label class="sr-only" for="qd-brief">Brief</label>
	<textarea id="qd-brief" name="brief" rows="3" maxlength={BRIEF_MAX} placeholder="Brief: o que precisa ser feito"></textarea>
	<label class="sr-only" for="qd-kit">Kit</label>
	<input id="qd-kit" name="kit" maxlength={KIT_MAX} placeholder="Kit (opcional)" />
	<button class="qd-botao" disabled={enviando}>Criar pedido</button>
	{#if form && 'erro' in form}<p class="qd-aviso" role="alert">{form.erro}</p>{/if}
	{#if form && 'criado' in form}<p class="qd-ok" role="status">Pedido {form.criado} criado.</p>{/if}
</form>

<div class="qd-colunas">
	{#each ESTADOS as estado (estado)}
		<section class="qd-coluna" aria-label={ROTULO_ESTADO[estado]}>
			<h2><span>{ROTULO_ESTADO[estado]}</span><span>{porEstado[estado].length}</span></h2>
			<ul class="qd-lista">
				{#each porEstado[estado] as c (c.id)}
					{@const l = lease(c.leaseAte)}
					<li>
						<details class="qd-card" data-estado={c.estado}>
							<summary>
								<span class="qd-id">{c.id}</span>
								<span class="qd-titulo">{c.titulo}</span>
								<span class="qd-meta">
									{#if c.kit}<span>kit {c.kit}</span>{/if}
									{#if c.dono}<span>{c.dono}</span>{/if}
									{#if l && c.estado === 'pego'}<span class="qd-lease" data-vencido={l.vencido}>{l.txt}</span>{/if}
								</span>
							</summary>
							<div class="qd-corpo">
								{#if c.brief}<div><h3>Brief</h3><pre class="qd-texto">{c.brief}</pre></div>{/if}
								{#if c.resultado}<div><h3>Resultado{c.verdict ? ` · ${c.verdict}` : ''}</h3><pre class="qd-texto">{c.resultado}</pre></div>{/if}
								<div>
									<h3>Eventos</h3>
									{#if c.eventos.length === 0}
										<p class="qd-vazio">Sem eventos.</p>
									{:else}
										<ul class="qd-eventos">
											{#each c.eventos as e, i (i)}
												<li>{hora(e.ts)} · {e.tipo}{e.ator ? ` (${e.ator})` : ''}{e.texto ? `: ${e.texto}` : ''}</li>
											{/each}
										</ul>
									{/if}
								</div>
							</div>
						</details>
					</li>
				{:else}
					<li class="qd-vazio">Nada aqui.</li>
				{/each}
			</ul>
		</section>
	{/each}
</div>

<section class="qd-colmeia" aria-label="Colmeia">
	<h2>Colmeia</h2>
	{#if data.mensagens.length === 0}
		<p class="qd-vazio">Nenhuma mensagem entre bots ainda.</p>
	{:else}
		<ul class="qd-msgs">
			{#each data.mensagens as m, i (i)}
				<li><time>{hora(m.ts)}</time> <strong>{m.de}</strong> → <strong>{m.para}</strong>: {m.texto}</li>
			{/each}
		</ul>
	{/if}
</section>
