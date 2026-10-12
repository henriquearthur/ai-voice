<script lang="ts">
	import { mode, toggleMode } from 'mode-watcher';
	import Moon from 'phosphor-svelte/lib/Moon';
	import Sun from 'phosphor-svelte/lib/Sun';

	const dark = $derived(mode.current === 'dark');
</script>

<button
	type="button"
	onclick={toggleMode}
	class="grid size-9 place-items-center pointer-coarse:size-11 rounded-[var(--radius-control)] text-ink-soft transition-[color,background-color,scale] duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-hover hover:text-ink active:scale-[0.94]"
	aria-label={dark ? 'Usar tema claro' : 'Usar tema escuro'}
	title={dark ? 'Tema claro' : 'Tema escuro'}
>
	{#if dark}
		<Sun class="size-[1.125rem]" />
	{:else}
		<Moon class="size-[1.125rem]" />
	{/if}
</button>
