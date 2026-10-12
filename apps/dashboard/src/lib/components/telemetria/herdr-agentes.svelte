<script lang="ts">
	import Sparkline from './sparkline.svelte';
	import SubagentesArvore from './subagentes-arvore.svelte';
	import { ago, count } from '#lib/conversa/format.js';
	import { subagentesExemplo } from '#lib/telemetria/exemplo.js';
	import {
		bytes,
		contarSubagentes,
		ESTADO_ORDEM,
		ESTADO_ROTULO,
		normalizeEstado,
		pct,
		type AgenteEstado,
		type Herdr,
		type Ponto
	} from '#lib/telemetria/model.js';

	/** The herdr's agents, what needs attention first: state, time in it, memory, CPU and its recent shape. */
	let {
		herdr,
		historico,
		now
	}: { herdr: Herdr | null; historico: Readonly<Record<string, ReadonlyArray<Ponto>>>; now: number } = $props();

	const cor: Record<AgenteEstado, string> = {
		blocked: 'text-caution',
		working: 'text-brand',
		done: 'text-positive',
		idle: 'text-ink-faint',
		unknown: 'text-ink-faint'
	};

	const agentes = $derived(
		[...(herdr?.agentes ?? [])].sort(
			(a, b) => ESTADO_ORDEM[a.estado] - ESTADO_ORDEM[b.estado] || (a.desde ?? now) - (b.desde ?? now) || a.nome.localeCompare(b.nome)
		)
	);
	// Until the collector publishes `subagentes`, a clearly labelled sample shows what the tree will look like.
	const semCampo = $derived(agentes.length > 0 && agentes.every((a) => !a.subagentesPublicados));
	const exemplo = $derived(
		semCampo ? (normalizeEstado({ herdr: { agentes: [{ nome: 'exemplo', subagentes: subagentesExemplo(now) }] } }, now)?.herdr?.agentes[0]?.subagentes ?? []) : []
	);
	const desde = (at: number | null) => (at === null ? null : ago(at, now).replace(/^há /, ''));
</script>

<section aria-labelledby="herdr-title" class="sheet">
	<header class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-rule px-5 py-3.5">
		<h2 id="herdr-title" class="text-heading font-semibold text-ink">Agentes do herdr</h2>
		{#if herdr}
			<p class="meta tabular">
				{herdr.versao ? `herdr ${herdr.versao}` : 'herdr'}
				{#if herdr.workspaces !== null}
					· {herdr.workspaces}
					{herdr.workspaces === 1 ? 'workspace' : 'workspaces'}
				{/if}
				· {herdr.agentes.length}
				{herdr.agentes.length === 1 ? 'agente' : 'agentes'}
			</p>
		{/if}
	</header>
	{#if !herdr}
		<p class="px-5 py-6 meta">O coletor não trouxe dados do herdr.</p>
	{:else if !herdr.vivo}
		<p class="px-5 py-6 meta">O servidor do herdr não respondeu{herdr.erro ? `: ${herdr.erro}` : '.'}</p>
	{:else if agentes.length === 0}
		<p class="px-5 py-6 meta">Nenhum agente aberto no herdr agora.</p>
	{:else}
		<ul class="divide-y divide-rule">
			{#each agentes as a (a.id)}
				{@const pontos = historico[a.id] ?? historico[a.nome] ?? []}
				{@const tempo = desde(a.desde)}
				<li class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-5 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
					<div class="min-w-0">
						<p class="truncate text-body font-semibold text-ink">{a.nome}</p>
						<p class="flex flex-wrap items-center gap-x-2 text-meta">
							<span class={['inline-flex items-center gap-1.5 font-semibold', cor[a.estado]]}>
								<span class="status-dot" aria-hidden="true"></span>
								{ESTADO_ROTULO[a.estado]}
							</span>
							{#if tempo}<span class="tabular text-ink-soft">há {tempo}</span>{/if}
							{#if a.workspace}<span class="truncate text-ink-faint">{a.workspace}</span>{/if}
							{#if a.subagentes.length > 0}
								{@const c = contarSubagentes(a.subagentes)}
								<span class="tabular inline-flex items-center gap-1 rounded-full border border-rule px-2 text-micro text-ink-soft" title="Subagentes abertos por este agente, diretos e aninhados">
									<span class="font-semibold text-ink">{count(c.total)}</span>
									{c.total === 1 ? 'subagente' : 'subagentes'}
									{#if c.rodando > 0}· <span class="text-brand">{count(c.rodando)} rodando</span>{/if}
									{#if c.parados > 0}· <span class="text-caution">{count(c.parados)} {c.parados === 1 ? 'parado' : 'parados'}</span>{/if}
									{#if c.concluidos > 0}· {count(c.concluidos)} {c.concluidos === 1 ? 'concluído' : 'concluídos'}{/if}
								</span>
							{/if}
						</p>
					</div>
					<dl class="flex gap-4 text-meta">
						<div class="text-right">
							<dt class="text-micro text-ink-faint">RAM</dt>
							<dd class="tabular font-medium text-ink">{bytes(a.ramBytes)}</dd>
						</div>
						<div class="w-12 text-right">
							<dt class="text-micro text-ink-faint">CPU</dt>
							<dd class="tabular font-medium text-ink">{pct(a.cpuPct)}</dd>
						</div>
					</dl>
					<div class="col-span-2 sm:col-span-1">
						<Sparkline {pontos} rotulo={a.nome} />
					</div>
					{#if a.subagentes.length > 0}
						<div class="col-span-full min-w-0 pl-1" aria-label="Subagentes de {a.nome}">
							<SubagentesArvore subagentes={a.subagentes} dono={a.nome} {now} />
						</div>
					{/if}
				</li>
			{/each}
		</ul>
		{#if semCampo}
			<details class="group border-t border-rule px-5 py-3">
				<summary class="cursor-pointer list-none text-meta text-ink-faint hover:text-ink-soft [&::-webkit-details-marker]:hidden">
					O coletor ainda não publica os subagentes. <span class="underline underline-offset-2">Ver um exemplo</span>
				</summary>
				<div class="mt-3 grid gap-2">
					<p class="text-micro font-semibold tracking-wide text-ink-faint uppercase">Exemplo, não são dados reais</p>
					<SubagentesArvore subagentes={exemplo} dono="maestro" {now} />
				</div>
			</details>
		{/if}
	{/if}
</section>
