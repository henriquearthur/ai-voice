<script lang="ts">
	import { bytes, codigoSaida, pct, saudePeriodico, type Servico } from '#lib/telemetria/model.js';
	import { ago, count, duration } from '#lib/conversa/format.js';

	/**
	 * One card per dev.jarvis.* LaunchAgent: alive, pid, restarts, memory and CPU. A periodic one (StartInterval, such as
	 * the maestro watchdog) runs and exits, so between runs it reads as scheduled, with its last run and exit code.
	 */
	let {
		servicos,
		fonte,
		now
	}: { servicos: ReadonlyArray<Servico>; fonte: 'ao-vivo' | 'prometheus'; now: number } = $props();

	type Tom = 'positive' | 'caution' | 'alert';

	const cada = (s: number) => (s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);

	function status(s: Servico): { tom: Tom; rotulo: string } {
		if (s.carregado === false) return { tom: 'alert', rotulo: 'Descarregado' };
		if (s.periodico) {
			const agenda = s.intervaloS ? `a cada ${cada(s.intervaloS)}` : 'por calendário';
			switch (saudePeriodico(s, now)) {
				case 'rodando':
					return { tom: 'positive', rotulo: 'Executando agora' };
				case 'falhou':
					return { tom: 'alert', rotulo: `Falhou · saída ${codigoSaida(s.ultimaSaida)}` };
				case 'atrasado':
					return { tom: 'alert', rotulo: `Atrasado · ${agenda}` };
				default:
					return { tom: 'positive', rotulo: `Agendado · ${agenda}` };
			}
		}
		if (!s.vivo) return { tom: 'alert', rotulo: 'Parado' };
		if (s.httpOk === false) return { tom: 'caution', rotulo: 'Sem resposta' };
		return { tom: 'positive', rotulo: 'No ar' };
	}

	const ok = (s: Servico) => status(s).tom !== 'alert';
	const ordenados = $derived([...servicos].sort((a, b) => Number(ok(a)) - Number(ok(b)) || a.nome.localeCompare(b.nome)));
</script>

<section aria-labelledby="servicos-title" class="grid gap-3">
	<div class="flex items-baseline justify-between gap-4">
		<h2 id="servicos-title" class="text-heading font-semibold text-ink">Serviços</h2>
		{#if fonte === 'prometheus' && servicos.length > 0}
			<p class="meta">última leitura da sonda, via Prometheus</p>
		{/if}
	</div>
	{#if servicos.length === 0}
		<p class="meta">O coletor ainda não informou nenhum serviço dev.jarvis.*.</p>
	{:else}
		<ul class="grid grid-cols-[repeat(auto-fill,minmax(13.5rem,1fr))] gap-3">
			{#each ordenados as s (s.nome)}
				{@const st = status(s)}
				{@const ocioso = s.periodico && !s.vivo}
				<li class="sheet grid gap-3 px-4 py-3.5">
					<div class="flex items-start justify-between gap-3">
						<div class="min-w-0">
							<p class="truncate text-body font-semibold text-ink capitalize">{s.nome}</p>
							<p class="truncate font-mono text-micro text-ink-faint">{s.label}</p>
						</div>
						<span
							class={[
								'inline-flex shrink-0 items-center gap-1.5 text-micro font-semibold',
								st.tom === 'positive' && 'text-positive',
								st.tom === 'caution' && 'text-caution',
								st.tom === 'alert' && 'text-alert'
							]}
						>
							<span class="status-dot" aria-hidden="true"></span>
							{st.rotulo}
						</span>
					</div>
					<dl class="grid grid-cols-2 gap-x-4 gap-y-1.5 text-meta">
						{#if s.periodico}
							<div class="col-span-2 flex justify-between gap-2">
								<dt class="text-ink-soft">Última execução</dt>
								<dd class="tabular font-medium text-ink">
									{s.vivo ? 'agora' : s.ultimaExecucao != null ? ago(s.ultimaExecucao, now) : '—'}
									{#if !s.vivo && codigoSaida(s.ultimaSaida) !== null}
										<span class={codigoSaida(s.ultimaSaida) === 0 ? 'text-ink-soft' : 'text-alert'}>
											· saída {codigoSaida(s.ultimaSaida)}
										</span>
									{/if}
								</dd>
							</div>
						{/if}
						{#if !ocioso}
							<div class="flex justify-between gap-2">
								<dt class="text-ink-soft">RAM</dt>
								<dd class="tabular font-medium text-ink">{bytes(s.ramBytes)}</dd>
							</div>
							<div class="flex justify-between gap-2">
								<dt class="text-ink-soft">CPU</dt>
								<dd class="tabular font-medium text-ink">{pct(s.cpuPct)}</dd>
							</div>
							<div class="flex justify-between gap-2">
								<dt class="text-ink-soft">PID</dt>
								<dd class="tabular font-medium text-ink">{s.pid ?? '—'}</dd>
							</div>
						{/if}
						{#if s.periodico}
							<div class="flex justify-between gap-2">
								<dt class="text-ink-soft">Execuções</dt>
								<dd class="tabular font-medium text-ink">{s.execucoes == null ? '—' : count(s.execucoes)}</dd>
							</div>
						{:else}
							<div class="flex justify-between gap-2">
								<dt class="text-ink-soft">Reinícios</dt>
								<dd class={['tabular font-medium', (s.reinicios ?? 0) > 3 ? 'text-caution' : 'text-ink']}>
									{s.reinicios === null ? '—' : count(s.reinicios)}
								</dd>
							</div>
						{/if}
						{#if s.healthMs !== null}
							<div class="col-span-2 flex justify-between gap-2">
								<dt class="text-ink-soft">Health</dt>
								<dd class="tabular font-medium text-ink">{duration(s.healthMs)}</dd>
							</div>
						{/if}
					</dl>
				</li>
			{/each}
		</ul>
	{/if}
</section>
