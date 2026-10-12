<script lang="ts">
	import './layout.css';
	import { onMount } from 'svelte';
	import { afterNavigate, beforeNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { ModeWatcher } from 'mode-watcher';
	import favicon from '#lib/assets/favicon.svg';
	import AppShell from '#lib/components/jarvis/app-shell.svelte';
	import { iniciarColeta, sinaisNavegacao } from '#lib/telemetria/web/coleta.js';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	// The frontend's own telemetry (Web Vitals, navigations, errors, live streams), batched every 15 s.
	onMount(() => iniciarColeta(page.route.id));
	beforeNavigate(({ willUnload }) => {
		if (!willUnload) sinaisNavegacao.inicio();
	});
	afterNavigate(({ type, to }) => {
		if (type !== 'enter') sinaisNavegacao.fim(to?.route.id ?? null);
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<!-- The browser chrome matches the shell's second neutral layer (--chrome). -->
<ModeWatcher themeColors={{ light: 'oklch(0.963 0.0035 85)', dark: 'oklch(0.153 0.004 70)' }} />

<AppShell>
	{@render children()}
</AppShell>
