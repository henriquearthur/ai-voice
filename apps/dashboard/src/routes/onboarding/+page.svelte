<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import ArrowClockwise from 'phosphor-svelte/lib/ArrowClockwise';
	import CalendarBlank from 'phosphor-svelte/lib/CalendarBlank';
	import DeviceMobile from 'phosphor-svelte/lib/DeviceMobile';
	import GearSix from 'phosphor-svelte/lib/GearSix';
	import Key from 'phosphor-svelte/lib/Key';
	import MagnifyingGlass from 'phosphor-svelte/lib/MagnifyingGlass';
	import Microphone from 'phosphor-svelte/lib/Microphone';
	import Robot from 'phosphor-svelte/lib/Robot';
	import SpeakerHigh from 'phosphor-svelte/lib/SpeakerHigh';
	import SpeakerSimpleHigh from 'phosphor-svelte/lib/SpeakerSimpleHigh';
	import CheckRow from '#lib/components/onboarding/check-row.svelte';
	import ModuleCard from '#lib/components/onboarding/module-card.svelte';
	import ModuleHeader from '#lib/components/jarvis/module-header.svelte';
	import Notice from '#lib/components/jarvis/notice.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import {
		itensNecessarios,
		type DeepMutable,
		type CheckItem,
		type OnboardingConfig,
		type OnboardingState,
		type SecretId
	} from '#lib/onboarding/model.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// svelte-ignore state_referenced_locally
	let estado = $state<OnboardingState | null>(data.local ? data.estado : null);
	// svelte-ignore state_referenced_locally
	let cfg = $state<DeepMutable<OnboardingConfig>>(
		structuredClone(data.local ? data.estado.config : ({} as OnboardingConfig)) as DeepMutable<OnboardingConfig>
	);
	let erro = $state<string | null>(null);
	let salvando = $state(false);
	let segredos = $state<Record<SecretId, string>>({ 'grokbot-webhook-url': '', 'grokbot-key': '' });
	let trocando = $state<Record<SecretId, boolean>>({ 'grokbot-webhook-url': false, 'grokbot-key': false });

	async function api(body: Record<string, unknown>) {
		const res = await fetch('/onboarding/api', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		const out = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(out?.message ?? `HTTP ${res.status}`);
		return out;
	}

	async function atualizar() {
		const res = await fetch('/onboarding/api', { cache: 'no-store' });
		if (res.ok) estado = await res.json();
	}

	// Grava as escolhas (sem concluir) logo que mudam: os instaladores leem o jarvis.env na hora.
	let timer: ReturnType<typeof setTimeout> | undefined;
	let primeiro = true;
	$effect(() => {
		const snapshot = JSON.stringify(cfg);
		if (primeiro) {
			primeiro = false;
			return;
		}
		clearTimeout(timer);
		timer = setTimeout(() => {
			api({ tipo: 'config', config: JSON.parse(snapshot) }).catch((e) => (erro = e.message));
		}, 500);
	});

	// Com tarefa em curso, consulta a cada 1,5 s; parada, a cada 15 s (alguém pode ter instalado no terminal).
	onMount(() => {
		let vivo = true;
		const loop = async () => {
			if (!vivo) return;
			const rodando = estado?.jobs.some((j) => j.estado === 'rodando');
			await atualizar().catch(() => undefined);
			if (vivo) setTimeout(loop, rodando ? 1500 : 15000);
		};
		const t = setTimeout(loop, 1500);
		return () => {
			vivo = false;
			clearTimeout(t);
		};
	});

	async function acao(item: string) {
		erro = null;
		try {
			await api({ tipo: 'config', config: cfg });
			await api({ tipo: 'instalar', item });
			await atualizar();
		} catch (e) {
			erro = e instanceof Error ? e.message : String(e);
		}
	}
	async function cancelar(item: string) {
		await api({ tipo: 'cancelar', item }).catch(() => undefined);
		await atualizar();
	}
	async function salvarSegredo(id: SecretId) {
		erro = null;
		try {
			await api({ tipo: 'segredo', id, valor: segredos[id] });
			segredos[id] = '';
			trocando[id] = false;
			await atualizar();
		} catch (e) {
			erro = e instanceof Error ? e.message : String(e);
		}
	}
	async function concluir() {
		salvando = true;
		erro = null;
		try {
			await api({ tipo: 'concluir', config: cfg });
			await goto('/', { invalidateAll: true });
		} catch (e) {
			erro = e instanceof Error ? e.message : String(e);
		} finally {
			salvando = false;
		}
	}

	const jobDe = (id: string) => estado?.jobs.find((j) => j.item === id);
	const necessarios = $derived(estado ? itensNecessarios(estado.itens, cfg as OnboardingConfig) : []);
	const idsNecessarios = $derived(new Set(necessarios.map((i) => i.id)));
	const pendentes = $derived(necessarios.filter((i) => i.status !== 'ok' && i.status !== 'nao-se-aplica'));
	const grupos: Array<{ id: CheckItem['grupo']; titulo: string }> = [
		{ id: 'dependencias', titulo: 'Dependências' },
		{ id: 'modelos', titulo: 'Modelos locais' },
		{ id: 'servicos', titulo: 'Serviços e integrações' }
	];
	const visiveis = (grupo: CheckItem['grupo']) =>
		(estado?.itens ?? []).filter(
			(i) => i.grupo === grupo && (idsNecessarios.has(i.id) || (cfg.modo === 'completo' && i.status !== 'nao-se-aplica'))
		);
	const ordenar = (itens: CheckItem[]) =>
		[...itens].sort((a, b) => Number(idsNecessarios.has(b.id)) - Number(idsNecessarios.has(a.id)));
</script>

<svelte:head><title>Configurar · Jarvis</title></svelte:head>

{#if !data.local || !estado}
	<ModuleHeader title="Configurar o Jarvis" icon={GearSix} />
	<Notice tone="caution" title="A configuração só abre no próprio Mac">
		Instalar, baixar modelos e gravar segredos ficam restritos a este computador. Abra o Jarvis.app, ou
		<code>http://127.0.0.1:7350/onboarding</code> no Mac.
	</Notice>
{:else}
	<ModuleHeader title={estado.configurado ? 'Configurações' : 'Boas-vindas ao Jarvis'} icon={GearSix}>
		{#snippet summary()}
			{#if pendentes.length === 0}
				Tudo o que você escolheu está pronto neste Mac.
			{:else}
				Escolha o mínimo que quiser. {pendentes.length}
				{pendentes.length === 1 ? 'item ainda falta' : 'itens ainda faltam'} para o que está ligado.
			{/if}
		{/snippet}
		{#snippet actions()}
			<Button variant="ghost" size="sm" onclick={atualizar}>
				<ArrowClockwise />Detectar de novo
			</Button>
		{/snippet}
	</ModuleHeader>

	<div class="grid gap-8 md:gap-10">
		<!-- 1. Modo -->
		<section aria-labelledby="modo-t" class="grid gap-3">
			<h2 id="modo-t" class="text-heading font-semibold text-ink">Como você quer começar?</h2>
			<div class="grid gap-3 sm:grid-cols-2">
				{#each [{ v: 'minimo', t: 'Mínimo', d: 'Só o dashboard e o Claude Code. Nada é baixado nem fica rodando a mais.' }, { v: 'completo', t: 'Escolher módulos', d: 'Voz, Escuta, agentes, Echo e o resto: ligue só o que for usar.' }] as op (op.v)}
					<label
						class={[
							'panel row-interactive grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] gap-3 p-4 sm:p-5',
							cfg.modo === op.v && 'border-[color-mix(in_oklch,var(--brand)_45%,var(--rule))] shadow-[0_0_0_3px_color-mix(in_oklch,var(--brand)_14%,transparent)]'
						]}
					>
						<input type="radio" name="modo" value={op.v} bind:group={cfg.modo} class="mt-1 accent-[var(--brand)]" />
						<span>
							<span class="block text-[0.9375rem] font-semibold text-ink">{op.t}</span>
							<span class="mt-0.5 block text-meta text-ink-soft">{op.d}</span>
						</span>
					</label>
				{/each}
			</div>
		</section>

		<!-- 2. Módulos -->
		{#if cfg.modo === 'completo'}
			<section aria-labelledby="mod-t" class="grid gap-3">
				<div>
					<h2 id="mod-t" class="text-heading font-semibold text-ink">Módulos</h2>
					<p class="meta">Desligado, o módulo não instala nada. Dá para mudar depois em Configurações.</p>
				</div>
				<div class="grid gap-3 lg:grid-cols-2">
					<ModuleCard
						titulo="Voz"
						icon={SpeakerHigh}
						descricao="O Jarvis fala no Mac com o Kokoro, local."
						precisa="Apple Silicon, Python 3.12 (uv), ~330 MB de modelo"
						bind:ligado={cfg.modulos.voz}
					>
						<div class="grid gap-3 sm:grid-cols-2">
							<label class="grid gap-1.5">
								<span class="field-label">Voz</span>
								<select class="field-input" bind:value={cfg.voz.voice}>
									<option value="pf_dora">pf_dora (feminina, pt-BR)</option>
									<option value="pm_alex">pm_alex (masculina, pt-BR)</option>
									<option value="pm_santa">pm_santa (masculina, pt-BR)</option>
								</select>
							</label>
							<label class="grid gap-1.5">
								<span class="field-label">Velocidade <span class="tabular text-ink-faint">{cfg.voz.speed.toFixed(2)}×</span></span>
								<input type="range" min="0.8" max="1.5" step="0.05" bind:value={cfg.voz.speed} class="mt-2 accent-[var(--brand)]" />
							</label>
						</div>
					</ModuleCard>

					<ModuleCard
						titulo="Escuta"
						icon={Microphone}
						descricao="Você fala, o pedido vai para um agente. Wake word e conversa contínua."
						precisa="macOS 26, Xcode CLT, herdr, microfone; Parakeet ~470 MB (opcional)"
						bind:ligado={cfg.modulos.escuta}
					>
						<label class="grid gap-1.5">
							<span class="field-label">Microfone</span>
							<select class="field-input" bind:value={cfg.escuta.mic}>
								<option value="">O padrão do sistema</option>
								{#each estado.microfones as mic (mic.nome)}
									<option value={mic.nome}>{mic.nome}{mic.padrao ? ' (padrão agora)' : ''}</option>
								{/each}
							</select>
						</label>
						<fieldset class="grid gap-1.5">
							<legend class="field-label mb-1.5">Reconhecimento de fala</legend>
							<div class="segmented">
								<label class="segment"><input class="sr-only" type="radio" value="parakeet" bind:group={cfg.escuta.stt} />Parakeet (local)</label>
								<label class="segment"><input class="sr-only" type="radio" value="apple" bind:group={cfg.escuta.stt} />Apple</label>
							</div>
						</fieldset>
						<label class="grid gap-1.5">
							<span class="field-label">Agente do herdr que recebe os pedidos</span>
							<input class="field-input" placeholder="ex.: maestro" bind:value={cfg.escuta.orquestrador} />
						</label>
					</ModuleCard>

					<ModuleCard
						titulo="Agentes no herdr"
						icon={Robot}
						descricao="Sessões do Claude Code em panes do herdr, que a Escuta e o maestro acionam."
						precisa="herdr e Claude Code"
						bind:ligado={cfg.modulos.agentes}
					/>

					<ModuleCard
						titulo="Echo (Alexa)"
						icon={SpeakerSimpleHigh}
						descricao="Fala na Echo da sala, com a sua conta da Amazon."
						precisa="conta Amazon com uma Echo; login pela página local"
						bind:ligado={cfg.modulos.echo}
					>
						<div class="grid gap-3 sm:grid-cols-2">
							<label class="grid gap-1.5">
								<span class="field-label">Marketplace</span>
								<select class="field-input" bind:value={cfg.echo.amazonPage}>
									{#each ['amazon.com.br', 'amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.es', 'amazon.it', 'amazon.fr'] as m (m)}
										<option value={m}>{m}</option>
									{/each}
								</select>
							</label>
							<label class="grid gap-1.5">
								<span class="field-label">Falar por padrão em</span>
								<select class="field-input" bind:value={cfg.echo.output}>
									<option value="mac">Mac</option>
									<option value="echo">Echo</option>
								</select>
							</label>
						</div>
						<label class="grid gap-1.5">
							<span class="field-label">Serial da Echo padrão (opcional, depois do login)</span>
							<input class="field-input font-mono" autocomplete="off" bind:value={cfg.echo.defaultDevice} />
						</label>
					</ModuleCard>

					<ModuleCard
						titulo="Grok Bot"
						icon={MagnifyingGlass}
						descricao="Pesquisa em redes sociais; a resposta volta pelo callback local."
						precisa="URL do webhook e chave do Grok Bot (vão para o Keychain), Tailscale Funnel"
						bind:ligado={cfg.modulos.grok}
					>
						{#each [{ id: 'grokbot-webhook-url', t: 'URL do webhook' }, { id: 'grokbot-key', t: 'Chave' }] as s (s.id)}
							{@const sid = s.id as SecretId}
							<div class="grid gap-1.5">
								<span class="field-label flex items-center gap-1.5"><Key class="size-3.5" />{s.t}</span>
								{#if estado.segredos[sid] && !trocando[sid]}
									<p class="flex items-center justify-between gap-2 text-meta text-ink-soft">
										<span><span class="text-positive">●</span> Salvo no Keychain. O valor não é mostrado.</span>
										<Button variant="ghost" size="xs" onclick={() => (trocando[sid] = true)}>Trocar</Button>
									</p>
								{:else}
									<form class="flex gap-2" onsubmit={(e) => (e.preventDefault(), salvarSegredo(sid))}>
										<input
											class="field-input font-mono"
											type="password"
											autocomplete="off"
											spellcheck="false"
											aria-label={s.t}
											bind:value={segredos[sid]}
										/>
										<Button type="submit" variant="outline" disabled={!segredos[sid].trim()}>Salvar</Button>
									</form>
								{/if}
							</div>
						{/each}
					</ModuleCard>

					<ModuleCard
						titulo="Tailscale e iPhone"
						icon={DeviceMobile}
						descricao="Abre o Jarvis no iPhone pela sua tailnet, sem expor à internet."
						precisa="Tailscale instalado e logado"
						bind:ligado={cfg.modulos.tailscale}
					>
						<p class="text-meta text-ink-soft">
							Depois de instalar e entrar no Tailscale, rode <code class="kbd !inline !h-auto px-1">tailscale serve --bg 7350</code> e abra o
							endereço <span class="font-mono">https://seu-mac.sua-tailnet.ts.net</span> no iPhone.
						</p>
					</ModuleCard>

					<ModuleCard
						titulo="Calendário e lembretes"
						icon={CalendarBlank}
						descricao="Agenda do dia e lembretes no dashboard e no Claude Code."
						precisa="Xcode CLT; o macOS pede a permissão no primeiro uso"
						bind:ligado={cfg.modulos.apple}
					/>
				</div>
			</section>
		{/if}

		<!-- 3. Checklist -->
		<section aria-labelledby="chk-t" class="grid gap-3">
			<div>
				<h2 id="chk-t" class="text-heading font-semibold text-ink">Neste Mac</h2>
				<p class="meta">Detectado agora. Os downloads seguem em segundo plano e retomam de onde pararam.</p>
			</div>
			{#if erro}
				<Notice tone="alert" title="Não deu certo">{erro}</Notice>
			{/if}
			{#each grupos as g (g.id)}
				{@const itens = ordenar(visiveis(g.id))}
				{#if itens.length}
					<div class="panel overflow-hidden">
						<h3 class="border-b border-rule bg-sunken/50 px-4 py-2 text-meta font-semibold text-ink-soft sm:px-5">{g.titulo}</h3>
						<ul class="divide-y divide-rule">
							{#each itens as item (item.id)}
								<CheckRow
									{item}
									job={jobDe(item.id)}
									opcional={!idsNecessarios.has(item.id)}
									onacao={acao}
									oncancelar={cancelar}
								/>
							{/each}
						</ul>
					</div>
				{/if}
			{/each}
		</section>

		<!-- 4. Concluir -->
		<div class="flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-5">
			<p class="meta max-w-[60ch]">
				Suas escolhas ficam em <span class="font-mono">~/.config/jarvis</span> (arquivos 0600) e os segredos no Keychain. Nada vai
				para o repositório.
			</p>
			<Button variant="brand" size="lg" disabled={salvando} onclick={concluir}>
				{pendentes.length ? 'Concluir assim mesmo' : 'Concluir'}
			</Button>
		</div>
	</div>
{/if}
