<script lang="ts">
	import type { Tone, WaveMode } from '#lib/conversa/model.js';

	/**
	 * The escuta's wave, drawn from its state (the browser never touches the microphone).
	 * Each bar is two layers: an envelope that sets how tall the state is allowed to go (a transition,
	 * so moving between states glides) and the bar itself, whose rhythm depends on the state.
	 * Reduced motion keeps the envelope and the colour, and drops the rhythm.
	 */
	let { mode, tone, bars = 64 }: { mode: WaveMode; tone: Tone; bars?: number } = $props();

	// A bell over the width, slightly uneven so it reads as a voice and not as a chart.
	const shape = $derived(
		Array.from({ length: bars }, (_, i) => {
			const x = (i + 0.5) / bars;
			const bell = Math.exp(-Math.pow((x - 0.5) / 0.26, 2));
			const grain = 0.78 + 0.22 * Math.abs(Math.sin(i * 12.9898) * 43758.5453 % 1);
			return { bell, grain, offset: Math.round((Math.abs(Math.sin(i * 78.233)) * 1000) % 900) };
		})
	);

	const amplitude = (bell: number, grain: number) => {
		switch (mode) {
			case 'idle':
				return 0.1 + bell * 0.16 * grain;
			case 'voice':
				return 0.18 + bell * 0.8 * grain;
			case 'speak':
				return 0.22 + bell * 0.76 * grain;
			case 'send':
				return 0.16 + bell * 0.5;
			case 'flat':
				return 0.07;
		}
	};
</script>

<div class={['wave', `mode-${mode}`, `tone-${tone}`]} aria-hidden="true">
	{#each shape as bar, i (i)}
		<span class="envelope" style:--amp={amplitude(bar.bell, bar.grain)}>
			<span class="bar" style:--i={i} style:--offset="{-bar.offset}ms"></span>
		</span>
	{/each}
</div>

<style>
	.wave {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: clamp(2px, 0.5vw, 4px);
		height: var(--wave-height, 6.5rem);
		transition: color 420ms ease;
		/* The line fades out at both ends, like the room going quiet. */
		mask-image: linear-gradient(to right, transparent, black 9%, black 91%, transparent);
	}

	.tone-positive {
		color: var(--positive);
	}
	.tone-brand {
		color: var(--brand);
	}
	.tone-neutral {
		color: var(--ink-faint);
	}
	.tone-caution {
		color: var(--caution);
	}
	.tone-alert {
		color: var(--alert);
	}

	.envelope {
		display: flex;
		flex: 1 1 0;
		align-items: center;
		height: 100%;
		min-width: 2px;
		max-width: 5px;
		transform: scaleY(var(--amp));
		transition: transform 520ms var(--ease-out);
	}

	.bar {
		width: 100%;
		height: 100%;
		border-radius: 999px;
		background: currentColor;
		opacity: 0.9;
		transition: opacity 420ms ease;
	}

	.mode-flat .bar {
		opacity: 0.45;
	}
	.mode-idle .bar {
		opacity: 0.7;
		/* Finite on purpose: a state change animates, then the wave rests (an open window must not burn the GPU). */
		animation: breathe 2600ms var(--ease-in-out) 2 alternate;
		animation-delay: calc(var(--i) * -95ms);
	}
	.mode-voice .bar {
		animation: talk 940ms var(--ease-in-out) 4 alternate;
		animation-delay: var(--offset);
	}
	.mode-speak .bar {
		animation: talk 720ms var(--ease-in-out) 4 alternate;
		animation-delay: var(--offset);
	}
	.mode-send .bar {
		animation: sweep 1250ms linear 2;
		animation-delay: calc(var(--i) * 18ms - 1250ms);
	}

	@keyframes breathe {
		from {
			transform: scaleY(0.55);
		}
		to {
			transform: scaleY(1);
		}
	}

	@keyframes talk {
		0% {
			transform: scaleY(0.28);
		}
		30% {
			transform: scaleY(1);
		}
		55% {
			transform: scaleY(0.46);
		}
		78% {
			transform: scaleY(0.86);
		}
		100% {
			transform: scaleY(0.34);
		}
	}

	/* A pulse that leaves on the left and goes out on the right: the request on its way. */
	@keyframes sweep {
		0% {
			transform: scaleY(0.3);
			opacity: 0.55;
		}
		10% {
			transform: scaleY(1);
			opacity: 1;
		}
		26% {
			transform: scaleY(0.3);
			opacity: 0.55;
		}
		100% {
			transform: scaleY(0.3);
			opacity: 0.55;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.bar {
			animation: none !important;
		}
		.envelope {
			transition-duration: 0ms;
		}
	}
</style>
