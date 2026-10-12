<script lang="ts">
	import CallPanel from '#lib/components/ir/call-panel.svelte';
	import MapsPanel from '#lib/components/ir/maps-panel.svelte';
	import ModuleHeader from '#lib/components/jarvis/module-header.svelte';
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();
</script>

<svelte:head>
	<title>Ir & ligar · Jarvis</title>
</svelte:head>

<div class="mx-auto grid max-w-[72rem] gap-7">
	<ModuleHeader title="Ir & ligar">
		{#snippet summary()}
			Buscas e rotas abrem no Mapas do Mac; ligações saem pelo iPhone ou pelo FaceTime, sempre com a sua confirmação.
		{/snippet}
	</ModuleHeader>

	<div class="grid grid-cols-1 items-start gap-x-8 gap-y-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] xl:gap-x-10">
		<MapsPanel result={form} />
		<CallPanel result={form} />
	</div>
</div>
