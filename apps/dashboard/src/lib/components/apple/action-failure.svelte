<script lang="ts">
	import type { AppleFailure } from '#lib/apple/failure.js';
	import Notice from '#lib/components/jarvis/notice.svelte';

	/**
	 * Why a form action against a macOS app failed, said the same way in every module.
	 * `app` is the app's name as System Settings shows it ("Lembretes", "Mapas");
	 * `nothing` states the side effect that did not happen ("Nada foi salvo.").
	 */
	let { failure, app, nothing }: { failure: AppleFailure; app: string; nothing: string } = $props();

	const title = $derived(
		{
			permission: `O macOS bloqueou o acesso ao app ${app}. ${nothing}`,
			timeout: `O app ${app} não respondeu a tempo.`,
			automation: `O app ${app} recusou o pedido. ${nothing}`,
			unexpected: `O pedido falhou no servidor. ${nothing}`
		}[failure.kind]
	);
</script>

<Notice tone={failure.kind === 'timeout' ? 'caution' : 'alert'} {title}>
	<p>
		{#if failure.kind === 'permission'}
			Em Ajustes do Sistema › Privacidade e Segurança › Automação, ligue “{app}” sob o app que roda o dashboard
			(Terminal, iTerm, Ghostty). Depois tente de novo.
		{:else if failure.kind === 'timeout'}
			Se o macOS mostrou um pedido de permissão, responda e tente de novo. O pedido pode ter sido feito mesmo assim:
			confira no {app} antes de repetir.
		{:else if failure.kind === 'automation'}
			Revise os campos e tente de novo.
		{:else}
			Tente de novo. Se repetir, veja o terminal do dashboard.
		{/if}
	</p>
	<p class="mt-1 text-xs">Resposta: {failure.message}</p>
</Notice>
