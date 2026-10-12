<script lang="ts">
	import { count, duration } from '#lib/conversa/format.js';
	import type { AppWeb } from '#lib/telemetria/web/app.js';

	/**
	 * The dashboard's own frontend (browser and Jarvis.app), last hour: p75 of LCP, INP and route
	 * navigations, errors, live-stream reconnections. Above the Web Vitals "good" line a number turns caution.
	 */
	let { app }: { app: AppWeb } = $props();

	const mib = (b: number) => `${Math.round(b / 1024 ** 2)} MB`;

	const itens = $derived([
		{ id: 'lcp', rotulo: 'LCP', detalhe: 'maior pintura, p75', valor: app.lcpP75, texto: app.lcpP75 === null ? '—' : duration(app.lcpP75), alerta: (app.lcpP75 ?? 0) > 2500 },
		{ id: 'inp', rotulo: 'INP', detalhe: 'resposta ao toque, p75', valor: app.inpP75, texto: app.inpP75 === null ? '—' : duration(app.inpP75), alerta: (app.inpP75 ?? 0) > 200 },
		{ id: 'nav', rotulo: 'Navegação', detalhe: 'entre abas, p75', valor: app.navegacaoP75, texto: app.navegacaoP75 === null ? '—' : duration(app.navegacaoP75), alerta: (app.navegacaoP75 ?? 0) > 1000 },
		{ id: 'erros', rotulo: 'Erros', detalhe: 'JS e promessas, 1 h', valor: app.erros, texto: app.erros === null ? '—' : count(app.erros), alerta: (app.erros ?? 0) > 0 },
		{ id: 'reconexoes', rotulo: 'Reconexões', detalhe: 'ao vivo (SSE), 1 h', valor: app.reconexoes, texto: app.reconexoes === null ? '—' : count(app.reconexoes), alerta: (app.reconexoes ?? 0) > 10 }
	]);
	const vazio = $derived(itens.every((i) => i.valor === null));
</script>

<section aria-labelledby="app-web-title" class="sheet">
	<header class="flex items-baseline justify-between gap-4 border-b border-rule px-5 py-3.5">
		<h2 id="app-web-title" class="text-heading font-semibold text-ink">App</h2>
		<p class="meta">navegador e Jarvis.app, última hora</p>
	</header>
	{#if vazio}
		<p class="px-5 py-6 meta">
			{app.prometheus === 'fora' ? 'O Prometheus local não respondeu; sem números do app agora.' : 'O app ainda não mandou medições nesta hora.'}
		</p>
	{:else}
		<dl class="grid grid-cols-2 gap-x-5 gap-y-4 px-5 py-4">
			{#each itens as i (i.id)}
				<div class="grid min-w-0 gap-0.5">
					<dt class="min-w-0">
						<span class="text-meta font-semibold text-ink">{i.rotulo}</span>
						<span class="block truncate text-micro text-ink-faint">{i.detalhe}</span>
					</dt>
					<dd class={['tabular text-heading font-semibold', i.alerta ? 'text-caution' : 'text-ink']}>{i.texto}</dd>
				</div>
			{/each}
		</dl>
		{#if app.atrasoLiveP75 !== null || app.descartes !== null || app.heapBytes !== null}
			<p class="border-t border-rule px-5 py-2.5 text-micro text-ink-faint tabular">
				{#if app.atrasoLiveP75 !== null}Quadro ao vivo pintado em {duration(app.atrasoLiveP75)} (p75){/if}
				{#if app.descartes !== null} · {count(app.descartes)} quadros descartados (limite de 1 Hz ou repetidos){/if}
				{#if app.heapBytes !== null} · heap {mib(app.heapBytes)}{/if}
			</p>
		{/if}
	{/if}
</section>
