<script lang="ts">
	import { prefersReducedMotion } from 'svelte/motion';
	import type { TransitionConfig } from 'svelte/transition';
	import Lightning from 'phosphor-svelte/lib/Lightning';
	import WarningOctagon from 'phosphor-svelte/lib/WarningOctagon';
	import Waveform from 'phosphor-svelte/lib/Waveform';
	import SpeakingBars from '#lib/components/alexa/speaking-bars.svelte';
	import { ago, count, dayKey, dayLabel, duration, time } from '#lib/conversa/format.js';
	import { type Phase, type Reply, type Turn, splitHeard } from '#lib/conversa/model.js';

	/**
	 * The conversation, newest exchange on top: what the owner said (as transcribed, with how long it took
	 * to reach the orchestrator) and, under it, each time Jarvis answered out loud. The voice server keeps
	 * only the size of what it spoke, so an answer is shown as a voice clip with its length, never as text.
	 */
	let { turns, phase, now }: { turns: ReadonlyArray<Turn>; phase: Phase; now: number } = $props();

	const days = $derived.by(() => {
		const groups: { key: number; label: string; turns: Turn[] }[] = [];
		for (const turn of turns) {
			const key = dayKey(turn.at);
			const last = groups.at(-1);
			if (last?.key === key) last.turns.push(turn);
			else groups.push({ key, label: dayLabel(turn.at, now), turns: [turn] });
		}
		return groups;
	});

	const newestReply = $derived(turns[0]?.replies.at(-1)?.key ?? null);
	const speakingNow = $derived(phase.id === 'falando');

	// Long answers come in several clips; past the third they fold behind a button.
	const FOLD = 3;
	let unfolded = $state<Record<string, boolean>>({});

	// New exchanges rise into place with a blur that clears; reduced motion keeps only the fade.
	function arrive(_node: Element): TransitionConfig {
		const still = prefersReducedMotion.current;
		return {
			duration: still ? 160 : 320,
			easing: (t) => 1 - Math.pow(1 - t, 4),
			css: (t, u) => (still ? `opacity: ${t}` : `opacity: ${t}; transform: translateY(${10 * u}px); filter: blur(${4 * u}px)`)
		};
	}

	/** Clip width follows the length of the speech: 3 rem minimum, 15 rem at a minute. */
	const clipWidth = (seconds: number) => `${Math.min(15, 3 + seconds * 0.2)}rem`;
</script>

{#snippet jarvisMark()}
	<span class="grid size-7 shrink-0 place-items-center rounded-full border border-rule bg-raised text-brand shadow-xs" aria-hidden="true">
		<svg viewBox="0 0 24 24" class="size-4">
			<circle cx="12" cy="12" r="8.25" fill="none" stroke="currentColor" stroke-width="2.5" />
			<circle cx="12" cy="12" r="3" fill="currentColor" />
		</svg>
	</span>
{/snippet}

{#snippet clip(reply: Reply)}
	{@const live = speakingNow && reply.key === newestReply}
	<li class="flex flex-wrap items-center gap-x-3 gap-y-1">
		<span
			class={[
				'clip inline-flex h-9 items-center gap-2.5 rounded-full border pr-3.5 pl-3',
				live ? 'border-brand/35 bg-brand-soft text-brand' : 'border-rule bg-raised text-ink-soft'
			]}
		>
			<SpeakingBars active={live} class="text-[0.9375rem]" />
			<span class="clip-track" style:width={clipWidth(reply.speech)} aria-hidden="true"></span>
			<span class="tabular text-meta font-semibold text-ink">{duration(reply.speech * 1000)}</span>
		</span>
		<span class="tabular text-micro text-ink-faint">
			{#if live}
				<span class="font-semibold text-brand">falando agora</span> ·
			{/if}
			{time(reply.at)} · {count(reply.chars)} caracteres
		</span>
	</li>
{/snippet}

{#snippet replies(turn: Turn, label: string)}
	{@const open = unfolded[turn.key] ?? false}
	{@const shown = open ? turn.replies : turn.replies.slice(0, FOLD)}
	<div class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3">
		{@render jarvisMark()}
		<div class="jarvis-bubble min-w-0 justify-self-start rounded-[1.125rem] rounded-tl-md border border-rule bg-sunken px-4 pt-2.5 pb-3">
			<p class="text-meta font-semibold text-ink">
				{label}
				{#if turn.replies.length > 1}
					<span class="font-normal text-ink-soft">
						· <span class="tabular">{turn.replies.length}</span> falas, {duration(turn.replies.reduce((s, r) => s + r.speech, 0) * 1000)}
					</span>
				{/if}
			</p>
			<ul class="mt-2 grid gap-2">
				{#each shown as reply (reply.key)}
					{@render clip(reply)}
				{/each}
			</ul>
			{#if turn.replies.length > FOLD}
				<button
					type="button"
					class="mt-2 text-meta font-semibold text-brand underline-offset-4 hover:underline"
					aria-expanded={open}
					onclick={() => (unfolded[turn.key] = !open)}
				>
					{open ? 'Mostrar menos' : `Mostrar mais ${turn.replies.length - FOLD} ${turn.replies.length - FOLD === 1 ? 'fala' : 'falas'}`}
				</button>
			{/if}
		</div>
	</div>
{/snippet}

<section aria-labelledby="conversa-title" class="sheet overflow-clip">
	<header class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-rule px-5 py-3.5 sm:px-7">
		<h2 id="conversa-title" class="text-heading font-semibold text-ink">Conversa</h2>
		<p class="text-micro text-ink-faint">Mais recente em cima · respostas mostradas pela duração da fala</p>
	</header>

	{#if turns.length === 0}
		<div class="grid justify-items-center gap-2 px-6 py-14 text-center">
			<Waveform class="size-8 text-ink-faint" aria-hidden="true" />
			<p class="text-body font-semibold text-ink">Nenhum pedido por voz ainda</p>
			<p class="max-w-[42ch] text-meta text-ink-soft">
				Diga “Jarvis” e o pedido perto do Mac. O que ele entender aparece aqui, e cada resposta falada logo abaixo.
			</p>
		</div>
	{:else}
		<div class="grid gap-2 px-4 pt-2 pb-6 sm:px-7">
			{#each days as day (day.key)}
				<section aria-label={day.label}>
					<h3 class="day sticky top-13 z-10 -mx-4 bg-raised px-4 py-2.5 text-micro font-semibold text-ink-soft sm:-mx-7 sm:px-7 md:top-0">
						{day.label}
					</h3>
					<ol class="grid gap-7">
						{#each day.turns as turn, index (turn.key)}
							<li in:arrive class="grid gap-3">
								{#if turn.kind === 'pedido'}
									{@const split = turn.heard ? splitHeard(turn.heard, turn.text) : null}
									<div class="grid justify-items-end gap-1.5 pl-8 sm:pl-16">
										<div
											class="owner-bubble max-w-full rounded-[1.125rem] rounded-tr-md border border-brand/20 bg-brand-soft px-4 py-2.5 text-body text-ink"
										>
											{#if split}
												<span class="font-semibold text-brand">{split.lead.trim()}</span>
												{split.rest}
											{:else}
												{turn.heard ?? turn.text}
											{/if}
										</div>
										<p class="flex flex-wrap items-center justify-end gap-x-2.5 gap-y-1 text-micro text-ink-soft">
											<span class="tabular font-semibold text-ink-soft">
												Você · {time(turn.at)}
												{#if index === 0 && day.key === days[0].key}
													<span class="font-normal text-ink-faint">({ago(turn.at, now)})</span>
												{/if}
											</span>
											{#if turn.utterance !== null}
												<span class="tabular inline-flex items-center gap-1">
													<Waveform class="size-3.5 text-ink-faint" weight="bold" aria-hidden="true" />
													falou {duration(turn.utterance * 1000)}
												</span>
											{/if}
											{#if turn.delivery === 'enviando'}
												<span class="inline-flex items-center gap-1 font-semibold text-brand">
													<SpeakingBars active class="text-[0.75rem]" /> enviando…
												</span>
											{:else if turn.delivery === 'falhou'}
												<span class="inline-flex items-center gap-1 font-semibold text-alert">
													<WarningOctagon class="size-3.5" weight="fill" aria-hidden="true" />
													não entregue
												</span>
											{:else if turn.latencyMs !== null}
												<span
													class="tabular inline-flex items-center gap-1"
													title="Do fim da sua fala até o pedido chegar{turn.who ? ` ao ${turn.who}` : ''} (envio: {duration(turn.sendMs ?? 0)})."
												>
													<Lightning class="size-3.5 text-positive" weight="fill" aria-hidden="true" />
													entregue{turn.who ? ` ao ${turn.who}` : ''} em {duration(turn.latencyMs)}
												</span>
											{/if}
										</p>
										{#if turn.delivery === 'falhou' && turn.detail}
											<p class="max-w-[52ch] text-right text-micro text-alert">{turn.detail}</p>
										{/if}
									</div>

									{#if turn.replies.length > 0}
										{@render replies(turn, 'Jarvis respondeu falando')}
									{:else if turn.delivery === 'entregue' && index === 0 && day.key === days[0].key && now - turn.at < 3 * 60_000}
										<div class="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3">
											{@render jarvisMark()}
											<p class="thinking inline-flex items-center gap-2 justify-self-start rounded-full border border-rule bg-sunken px-3.5 py-2 text-meta text-ink-soft">
												<span class="dots" aria-hidden="true"><span></span><span></span><span></span></span>
												Aguardando a resposta falada
											</p>
										</div>
									{/if}
								{:else}
									{@render replies(turn, 'Jarvis falou sem pedido por voz antes')}
								{/if}
							</li>
						{/each}
					</ol>
				</section>
			{/each}
		</div>
	{/if}
</section>

<style>
	.owner-bubble {
		overflow-wrap: anywhere;
		text-wrap: pretty;
	}

	/* The clip's body: a dotted track, decoration only. Its length is the only fact it carries. */
	.clip-track {
		height: 0.875rem;
		max-width: 38vw;
		background-image: radial-gradient(circle, currentColor 1.1px, transparent 1.5px);
		background-size: 6px 100%;
		background-repeat: repeat-x;
		background-position: left center;
		opacity: 0.55;
	}

	.dots {
		display: inline-flex;
		gap: 3px;
	}
	.dots span {
		width: 5px;
		height: 5px;
		border-radius: 999px;
		background: currentColor;
		animation: dot 1200ms var(--ease-in-out) 3;
	}
	.dots span:nth-child(2) {
		animation-delay: 160ms;
	}
	.dots span:nth-child(3) {
		animation-delay: 320ms;
	}
	@keyframes dot {
		0%,
		60%,
		100% {
			opacity: 0.35;
			transform: translateY(0);
		}
		30% {
			opacity: 1;
			transform: translateY(-3px);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.dots span {
			animation: none;
			opacity: 0.6;
		}
	}
</style>
