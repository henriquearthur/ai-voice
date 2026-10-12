<script lang="ts" module>
	export type Connection = 'conectando' | 'ao-vivo' | 'reconectando';
	export type ControlFeedback = { message: string; failed?: boolean; at: number } | null;
</script>

<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import ArrowClockwise from 'phosphor-svelte/lib/ArrowClockwise';
	import Microphone from 'phosphor-svelte/lib/Microphone';
	import Pause from 'phosphor-svelte/lib/Pause';
	import Play from 'phosphor-svelte/lib/Play';
	import { Button } from '#lib/components/ui/button/index.js';
	import type { Phase, Snapshot } from '#lib/conversa/model.js';
	import LiveWave from './live-wave.svelte';

	/**
	 * The top of the conversation: what the escuta is doing right now, said big, drawn as a wave,
	 * with the two controls that are safe to drive from here.
	 */
	let {
		phase,
		snapshot,
		connection,
		feedback = $bindable(null)
	}: { phase: Phase; snapshot: Snapshot; connection: Connection; feedback?: ControlFeedback } = $props();

	let busy = $state<'pausar' | 'retomar' | 'reiniciar' | null>(null);

	const stopped = $derived(phase.id === 'desligada' || phase.id === 'pausada');
	const mic = $derived(snapshot.health.mic);

	const submit: SubmitFunction = ({ action }) => {
		busy = (action.search.replace('?/', '') as typeof busy) ?? null;
		feedback = null;
		return async ({ result }) => {
			if (result.type === 'success' || result.type === 'failure') {
				const data = result.data as { control?: { message: string; at: number; failed?: boolean } } | undefined;
				if (data?.control) feedback = data.control;
			} else if (result.type === 'error') {
				feedback = { message: 'O servidor não conseguiu falar com o launchd.', failed: true, at: Date.now() };
			}
			busy = null;
		};
	};

	const dot = {
		positive: 'text-positive',
		brand: 'text-brand',
		neutral: 'text-ink-faint',
		caution: 'text-caution',
		alert: 'text-alert'
	} as const;
</script>

<section aria-labelledby="stage-title" class="stage sheet overflow-hidden">
	<div class="grid gap-5 px-5 pt-5 sm:px-7 sm:pt-6">
		<div class="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
			<div class="min-w-0" aria-live="polite">
				<h2 id="stage-title" class="sr-only">Estado da escuta</h2>
				<p class="flex items-center gap-3">
					<span class={['status-dot live-dot', dot[phase.tone], phase.wave !== 'flat' && 'beating']}></span>
					{#key phase.id}
						<span class="phase-label display text-[1.875rem] leading-none text-ink sm:text-[2.25rem]">{phase.label}</span>
					{/key}
				</p>
				<p class="mt-2.5 max-w-[56ch] text-body text-ink-soft">{phase.hint}</p>
			</div>
			<p
				class={[
					'flex shrink-0 items-center gap-2 rounded-full border px-2.5 py-1 text-micro font-semibold',
					connection === 'ao-vivo' ? 'border-rule bg-sunken text-ink-soft' : 'border-caution/30 bg-caution-soft text-caution'
				]}
				title={connection === 'ao-vivo' ? 'Atualiza sozinho quando a escuta registra algo.' : undefined}
			>
				<span class={['size-1.5 rounded-full', connection === 'ao-vivo' ? 'bg-positive' : 'bg-caution']}></span>
				{connection === 'ao-vivo' ? 'Ao vivo' : connection === 'conectando' ? 'Conectando…' : 'Reconectando…'}
			</p>
		</div>

		<LiveWave mode={phase.wave} tone={phase.tone} />
	</div>

	<div
		class="mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-t border-rule bg-sunken/60 px-5 py-3 sm:px-7"
	>
		<p class="flex min-w-0 items-center gap-2 text-meta text-ink-soft">
			<Microphone class="size-4 shrink-0 text-ink-faint" weight="bold" aria-hidden="true" />
			{#if mic}
				<span class="truncate">{mic}</span>
			{:else}
				<span>Microfone ainda não informado</span>
			{/if}
		</p>

		<div class="flex flex-wrap items-center gap-2">
			{#if stopped}
				<form method="POST" action="?/retomar" use:enhance={submit}>
					<Button type="submit" variant="brand" size="sm" disabled={busy !== null}>
						{#if busy === 'retomar'}
							<ArrowClockwise class="size-3.5 animate-spin" weight="bold" aria-hidden="true" />
							Ligando…
						{:else}
							<Play class="size-3.5" weight="fill" aria-hidden="true" />
							{phase.id === 'desligada' ? 'Ligar escuta' : 'Retomar'}
						{/if}
					</Button>
				</form>
			{:else}
				<form method="POST" action="?/pausar" use:enhance={submit}>
					<Button
						type="submit"
						variant="outline"
						size="sm"
						disabled={busy !== null}
						title="Fecha o microfone e tira a escuta da barra de menus até você retomar (ou até o próximo login)."
					>
						{#if busy === 'pausar'}
							<ArrowClockwise class="size-3.5 animate-spin" weight="bold" aria-hidden="true" />
							Pausando…
						{:else}
							<Pause class="size-3.5" weight="fill" aria-hidden="true" />
							Pausar
						{/if}
					</Button>
				</form>
			{/if}
			{#if phase.id !== 'desligada'}
				<form method="POST" action="?/reiniciar" use:enhance={submit}>
					<Button
						type="submit"
						variant="ghost"
						size="sm"
						disabled={busy !== null}
						title="Abre o microfone e o reconhecimento de novo, do zero."
					>
						<ArrowClockwise class={['size-3.5', busy === 'reiniciar' && 'animate-spin']} weight="bold" aria-hidden="true" />
						{busy === 'reiniciar' ? 'Reiniciando…' : 'Reiniciar'}
					</Button>
				</form>
			{/if}
		</div>
	</div>

	{#if feedback}
		<p
			role={feedback.failed ? 'alert' : 'status'}
			class={[
				'feedback border-t px-5 py-2.5 text-meta sm:px-7',
				feedback.failed ? 'border-alert/25 bg-alert-soft text-alert' : 'border-rule bg-positive-soft text-ink'
			]}
		>
			{feedback.message}
		</p>
	{/if}
</section>

<style>
	/* The state's name changes with a short blur that clears: one word replacing another, not a slide. */
	.phase-label {
		display: inline-block;
		animation: settle 260ms var(--ease-out);
	}
	@keyframes settle {
		from {
			opacity: 0;
			filter: blur(4px);
			transform: translateY(3px);
		}
	}

	/* The dot beats a few times when the escuta comes alive, then holds still. */
	.beating {
		animation: beat 1800ms var(--ease-out) 3;
	}
	@keyframes beat {
		0% {
			box-shadow: 0 0 0 0 color-mix(in oklch, currentColor 40%, transparent);
		}
		70%,
		100% {
			box-shadow: 0 0 0 8px color-mix(in oklch, currentColor 0%, transparent);
		}
	}
	.live-dot {
		width: 0.625rem;
		height: 0.625rem;
		transition: color 420ms ease;
	}

	.feedback {
		animation: settle 220ms var(--ease-out);
	}

	@media (prefers-reduced-motion: reduce) {
		.phase-label,
		.feedback {
			animation: fade 160ms ease;
		}
		.beating {
			animation: none;
		}
		@keyframes fade {
			from {
				opacity: 0;
			}
		}
	}
</style>
