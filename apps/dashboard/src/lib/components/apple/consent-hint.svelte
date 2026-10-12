<script lang="ts">
	import { onMount } from 'svelte';
	import LockKey from 'phosphor-svelte/lib/LockKey';

	/** `app` is the macOS app's name as the consent dialog shows it, e.g. "Lembretes". */
	let { app }: { app: string } = $props();

	// Most reads finish fast; the note only appears when the read lingers, which is what a pending
	// macOS permission dialog looks like.
	let lingering = $state(false);
	onMount(() => {
		const timer = setTimeout(() => (lingering = true), 1200);
		return () => clearTimeout(timer);
	});
</script>

<div aria-live="polite">
	{#if lingering}
		<aside
			class="consent grid max-w-[36rem] grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-rule bg-paper-sunk px-4 py-3.5 text-sm"
		>
			<LockKey class="mt-px size-[1.125rem] text-carbon" weight="bold" aria-hidden="true" />
			<p class="font-semibold text-ink">Ainda lendo o app {app}.</p>
			<p class="col-start-2 text-ink-soft">
				Pode levar alguns segundos. Na primeira vez, o macOS pergunta se o seu terminal pode controlar o {app}:
				clique em <span class="font-semibold text-ink">OK</span>. O aviso pode abrir atrás do navegador.
			</p>
		</aside>
	{/if}
</div>

<style>
	.consent {
		transition:
			opacity 240ms var(--ease-out),
			translate 240ms var(--ease-out);

		@starting-style {
			opacity: 0;
			translate: 0 4px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.consent {
			transition: opacity 160ms ease;
			translate: none;
		}
	}
</style>
