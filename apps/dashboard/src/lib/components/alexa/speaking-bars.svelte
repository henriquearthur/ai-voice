<script lang="ts">
	import type { ClassValue } from 'svelte/elements';

	/**
	 * Five level bars. Still, they are the Mac's mark; while `active` they move, because the Mac is
	 * speaking right now and the request only returns when the audio ends. Reduced motion keeps them still.
	 */
	let { active = false, class: className }: { active?: boolean; class?: ClassValue } = $props();

	const rest = [0.45, 0.8, 1, 0.65, 0.35];
</script>

<span aria-hidden="true" class={['bars', active && 'active', className]}>
	{#each rest as level, index (index)}
		<span style:--level={level} style:--i={index}></span>
	{/each}
</span>

<style>
	.bars {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		height: 1em;
	}

	.bars > span {
		width: 2px;
		height: 100%;
		border-radius: 1px;
		background: currentColor;
		transform: scaleY(var(--level));
		transition: transform 240ms var(--ease-out);
	}

	.active > span {
		animation: level 820ms var(--ease-in-out) 4 alternate;
		animation-delay: calc(var(--i) * -170ms);
	}

	@keyframes level {
		0% {
			transform: scaleY(0.2);
		}
		55% {
			transform: scaleY(1);
		}
		100% {
			transform: scaleY(0.4);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.active > span {
			animation: none;
		}
	}
</style>
