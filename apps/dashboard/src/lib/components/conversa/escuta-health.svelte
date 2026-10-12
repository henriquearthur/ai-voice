<script lang="ts">
	import type { Component } from 'svelte';
	import ArrowClockwise from 'phosphor-svelte/lib/ArrowClockwise';
	import Cpu from 'phosphor-svelte/lib/Cpu';
	import Headphones from 'phosphor-svelte/lib/Headphones';
	import Microphone from 'phosphor-svelte/lib/Microphone';
	import SpeakerHigh from 'phosphor-svelte/lib/SpeakerHigh';
	import TextAa from 'phosphor-svelte/lib/TextAa';
	import Timer from 'phosphor-svelte/lib/Timer';
	import { ago, count, duration } from '#lib/conversa/format.js';
	import type { Snapshot } from '#lib/conversa/model.js';

	/** The escuta's vital signs, the same rows as its menu bar panel, read from its logs and from launchd. */
	let { snapshot, now }: { snapshot: Snapshot; now: number } = $props();

	type State = 'ok' | 'warn' | 'off' | null;
	type Row = { icon: Component<{ class?: string; weight?: 'bold' }>; label: string; value: string; detail?: string; state: State };

	const rows = $derived.by((): Row[] => {
		const { process, health, voice } = snapshot;
		const out: Row[] = [];

		out.push({
			icon: Cpu,
			label: 'Processo',
			value:
				process.state === 'running'
					? 'Rodando'
					: process.state === 'stopped'
						? 'Encerrado'
						: process.state === 'unloaded'
							? 'Desligado'
							: 'Sem resposta do launchd',
			detail: process.pid ? `pid ${process.pid}` : undefined,
			state: process.state === 'running' ? 'ok' : process.state === 'unknown' ? 'warn' : 'off'
		});

		out.push({ icon: Microphone, label: 'Microfone', value: health.mic ?? 'Ainda não informado', state: health.mic ? 'ok' : null });

		out.push(
			health.airpods
				? {
						icon: Headphones,
						label: 'Fones',
						value: health.airpods.device,
						detail:
							health.airpods.rate >= 44_100
								? `${Math.round(health.airpods.rate / 1000)} kHz, estéreo`
								: `${Math.round(health.airpods.rate / 1000)} kHz, modo chamada`,
						state: health.airpods.rate >= 44_100 ? 'ok' : 'warn'
					}
				: { icon: Headphones, label: 'Fones', value: 'Nenhum informado', state: null }
		);

		const recentError = health.recognizerError && now - health.recognizerError.at < 10 * 60_000 ? health.recognizerError : null;
		out.push({
			icon: TextAa,
			label: 'Reconhecimento',
			value: recentError ? 'Com falha recente' : health.recognizer ? `Tarefa nº ${health.recognizer.generation}` : 'Aguardando',
			detail: recentError
				? recentError.message
				: health.recognizer && health.recognizer.generation > 1
					? `trocada ${ago(health.recognizer.at, now)}: ${health.recognizer.reason}`
					: undefined,
			state: recentError ? 'warn' : health.recognizer ? 'ok' : null
		});

		out.push({
			icon: SpeakerHigh,
			label: 'Voz do Jarvis',
			value: voice === 'ok' ? 'Kokoro local, pronto' : voice === 'off' ? 'Kokoro fora do ar' : 'Sem leitura',
			detail: voice === 'off' ? 'as respostas saem na voz do sistema e não aparecem na conversa' : undefined,
			state: voice === 'ok' ? 'ok' : 'warn'
		});

		if (health.silence !== null) {
			out.push({
				icon: Timer,
				label: 'Fim da fala',
				value: `${duration(health.silence * 1000)} de silêncio`,
				detail: health.openSilence !== null ? `${duration(health.openSilence * 1000)} se a frase ficar aberta` : undefined,
				state: null
			});
		}

		if (health.lastRestart) {
			out.push({
				icon: ArrowClockwise,
				label: 'Último reinício',
				value: ago(health.lastRestart.at, now),
				detail: [
					health.lastRestart.reason === 'menu' ? 'pelo painel' : health.lastRestart.reason,
					health.restartsToday > 1 ? `${count(health.restartsToday)} hoje` : null
				]
					.filter(Boolean)
					.join(' · '),
				state: null
			});
		}
		return out;
	});

	const mark = { ok: 'bg-positive', warn: 'bg-caution', off: 'border border-ink-faint bg-transparent' } as const;
</script>

<section aria-labelledby="health-title" class="sheet">
	<h2 id="health-title" class="border-b border-rule px-5 py-3.5 text-heading font-semibold text-ink">Escuta</h2>
	<dl class="divide-y divide-rule px-5">
		{#each rows as row (row.label)}
			<div class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 py-3">
				<dt class="pt-0.5">
					<row.icon class="size-4 text-ink-faint" weight="bold" />
					<span class="sr-only">{row.label}</span>
				</dt>
				<dd class="min-w-0">
					<p class="flex items-baseline justify-between gap-3">
						<span class="field-label shrink-0" aria-hidden="true">{row.label}</span>
						<span class="flex min-w-0 items-center gap-1.5 text-meta font-semibold text-ink">
							<span class="truncate">{row.value}</span>
							{#if row.state}
								<span class={['size-1.5 shrink-0 rounded-full', mark[row.state]]} aria-hidden="true"></span>
							{/if}
						</span>
					</p>
					{#if row.detail}
						<p class="mt-0.5 text-right text-micro text-ink-soft">{row.detail}</p>
					{/if}
				</dd>
			</div>
		{/each}
	</dl>
</section>
