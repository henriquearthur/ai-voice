<script lang="ts">
	import CopyButton from './copy-button.svelte';

	let { command }: { command: string } = $props();
</script>

<div class="flex items-stretch overflow-hidden rounded-[var(--radius-control)] border border-rule bg-sunken">
	<code class="min-w-0 flex-1 overflow-x-auto px-3 py-2.5 text-[0.8125rem] leading-5 whitespace-nowrap text-ink">
		<span class="text-ink-faint select-none" aria-hidden="true">$ </span>{command}
	</code>
	<CopyButton text={command} announce="Comando copiado" />
</div>
