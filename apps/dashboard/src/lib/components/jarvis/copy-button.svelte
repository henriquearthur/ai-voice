<script lang="ts">
	import Check from 'phosphor-svelte/lib/Check';
	import Copy from 'phosphor-svelte/lib/Copy';

	/** The joined "Copiar" end of a code or link field; `announce` is what a screen reader hears after copying. */
	let { text, announce = 'Copiado' }: { text: string; announce?: string } = $props();

	let copied = $state(false);
	let failed = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function copy() {
		clearTimeout(timer);
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
			failed = false;
		} catch {
			// Clipboard needs a secure context and focus; say so instead of failing silently.
			copied = false;
			failed = true;
		}
		timer = setTimeout(() => {
			copied = false;
			failed = false;
		}, 1600);
	}
</script>

<button
	type="button"
	onclick={copy}
	class="flex shrink-0 items-center gap-1.5 border-l border-rule bg-raised px-3 text-[0.8125rem] font-medium text-ink-soft transition-[background-color,color] duration-[var(--dur-fast)] ease-out hover:bg-accent hover:text-ink active:bg-pressed"
>
	<span class="grid size-4 place-items-center">
		{#if copied}
			<Check class="size-4 text-positive" weight="bold" aria-hidden="true" />
		{:else}
			<Copy class="size-4" aria-hidden="true" />
		{/if}
	</span>
	{#if copied}
		<span class="text-ink">Copiado</span>
	{:else if failed}
		<span class="text-alert">Copie à mão</span>
	{:else}
		Copiar
	{/if}
</button>
<span class="sr-only" aria-live="polite">{copied ? announce : failed ? 'Não deu para copiar. Selecione e copie à mão.' : ''}</span>
