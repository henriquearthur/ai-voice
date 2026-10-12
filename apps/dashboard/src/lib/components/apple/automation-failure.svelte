<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import ArrowClockwise from 'phosphor-svelte/lib/ArrowClockwise';
	import ArrowSquareOut from 'phosphor-svelte/lib/ArrowSquareOut';
	import type { AppleFailure } from '#lib/apple/failure.js';
	import Notice from '#lib/components/jarvis/notice.svelte';
	import { Button } from '#lib/components/ui/button/index.js';

	/** `app` is the macOS app's name as it shows in System Settings, e.g. "Lembretes". */
	let { failure, app }: { failure: AppleFailure; app: string } = $props();

	let retrying = $state(false);

	async function retry() {
		retrying = true;
		await refreshAll().finally(() => (retrying = false));
	}

	const SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation';
</script>

{#if failure.kind === 'permission' || failure.kind === 'timeout'}
	<section aria-labelledby="automation-title" class="max-w-[38rem]">
		<h2 id="automation-title" class="display text-[1.375rem] leading-tight text-ink">
			{failure.kind === 'permission' ? `Libere o acesso ao app ${app}` : `O app ${app} não respondeu`}
		</h2>
		<p class="mt-2 text-[0.9375rem] text-ink-soft">
			{#if failure.kind === 'permission'}
				O macOS bloqueou o Jarvis. A permissão de Automação é dada uma vez, nos Ajustes do Sistema, ao app que roda o
				dashboard: o seu terminal.
			{:else}
				Na primeira vez, o macOS pergunta se o Jarvis pode controlar o {app}. O pedido pode estar aberto atrás do
				navegador, esperando a sua resposta.
			{/if}
		</p>

		<ol class="mt-6 grid gap-5">
			{#if failure.kind === 'permission'}
				<li class="grid gap-2.5">
					<span class="text-sm font-semibold text-ink">1. Abra Privacidade e Segurança › Automação</span>
					<div>
						<Button variant="outline" href={SETTINGS_URL}>
							<ArrowSquareOut class="size-4" weight="bold" aria-hidden="true" />
							Abrir Ajustes do Sistema
						</Button>
					</div>
				</li>
				<li class="grid gap-1">
					<span class="text-sm font-semibold text-ink">2. Ligue “{app}” sob o seu terminal</span>
					<span class="text-sm text-ink-soft">Terminal, iTerm, Ghostty ou o app que rodou <code class="text-ink">bun run dev</code>.</span>
				</li>
			{:else}
				<li class="grid gap-1">
					<span class="text-sm font-semibold text-ink">1. Procure o pedido do macOS e clique em OK</span>
					<span class="text-sm text-ink-soft">Ele diz que o seu terminal quer controlar o app {app}.</span>
				</li>
			{/if}
			<li class="grid gap-2.5">
				<span class="text-sm font-semibold text-ink">{failure.kind === 'permission' ? '3' : '2'}. Volte aqui e tente de novo</span>
				<div>
					<Button variant="outline" onclick={retry} disabled={retrying}>
						<ArrowClockwise class={['size-4', retrying && 'animate-spin']} weight="bold" aria-hidden="true" />
						{retrying ? 'Verificando…' : 'Tentar de novo'}
					</Button>
				</div>
			</li>
		</ol>

		<p class="mt-6 border-t border-rule pt-3 text-xs text-ink-soft">
			Resposta do macOS: <span class="text-ink">{failure.message}</span>
		</p>
	</section>
{:else}
	<Notice tone="alert" title={failure.kind === 'automation' ? `O app ${app} recusou o pedido.` : 'A leitura falhou no servidor.'}>
		<p>{failure.message}</p>
		<p class="mt-2">
			<button
				type="button"
				onclick={retry}
				disabled={retrying}
				class="font-semibold text-carbon underline-offset-4 hover:underline disabled:opacity-60"
			>
				{retrying ? 'Verificando…' : 'Tentar de novo'}
			</button>
		</p>
	</Notice>
{/if}
