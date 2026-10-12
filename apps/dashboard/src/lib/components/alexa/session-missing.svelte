<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import ArrowClockwise from 'phosphor-svelte/lib/ArrowClockwise';
	import CopyCommand from '#lib/components/jarvis/copy-command.svelte';

	/**
	 * No Amazon session: only the Echo route is closed. The Mac keeps speaking, so this sits inside
	 * the Echo section as a short how-to instead of taking over the page.
	 */
	let { message }: { message: string } = $props();

	let checking = $state(false);

	async function check() {
		checking = true;
		await refreshAll().finally(() => (checking = false));
	}
</script>

<div class="grid gap-3 py-2.5 text-[0.8125rem]" role="status">
	<p class="text-ink">
		<span class="font-semibold">Alexa desconectada.</span>
		<span class="text-ink-soft">Para usar um Echo, entre na Amazon uma vez pelo terminal, na raiz do projeto.</span>
	</p>
	<CopyCommand command="bun apps/mcp/src/main.ts login" />
	<div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
		<button type="button" class="check" onclick={check} disabled={checking}>
			<ArrowClockwise class={['size-3.5', checking && 'animate-spin']} weight="bold" aria-hidden="true" />
			{checking ? 'Verificando…' : 'Já entrei, verificar'}
		</button>
		<span class="min-w-0 truncate text-xs text-ink-soft" title={message}>Amazon: {message}</span>
	</div>
</div>

<style>
	.check {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		border-radius: 3px;
		font-weight: 600;
		color: var(--carbon);
		text-decoration: underline;
		text-decoration-color: color-mix(in oklch, var(--carbon) 40%, transparent);
		text-underline-offset: 3px;
		transition: text-decoration-color 150ms ease;
	}

	.check:hover:not(:disabled) {
		text-decoration-color: currentColor;
	}

	.check:disabled {
		cursor: progress;
		opacity: 0.7;
	}
</style>
