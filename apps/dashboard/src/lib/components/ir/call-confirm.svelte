<script lang="ts">
	import type { Attachment } from 'svelte/attachments';
	import CircleNotch from 'phosphor-svelte/lib/CircleNotch';
	import PhoneCall from 'phosphor-svelte/lib/PhoneCall';
	import PhoneIcon from 'phosphor-svelte/lib/Phone';
	import { Button } from '#lib/components/ui/button/index.js';

	/** The footer of the call form: a review button, then, after review, the explicit last question. */
	let {
		confirming,
		pending,
		ready,
		display,
		viaLabel,
		oncancel
	}: {
		confirming: boolean;
		pending: boolean;
		ready: boolean;
		display: string;
		viaLabel: string;
		oncancel: () => void;
	} = $props();

	// The question takes focus when it appears, so a keyboard or screen reader user lands on it
	// instead of on the button that vanished. Not on "Sim, ligar": a stray Enter must not dial.
	const announce: Attachment<HTMLElement> = (node) => node.focus();
</script>

{#if confirming}
	<div role="group" aria-labelledby="call-confirm-title" class="confirm grid gap-4 border-t border-stamp/45 bg-stamp/6 px-4 pt-4 pb-4 sm:px-5">
		<div class="grid gap-1.5">
			<p class="field-label text-stamp!">Confirme a chamada</p>
			<p id="call-confirm-title" tabindex="-1" {@attach announce} class="text-[0.9375rem] text-ink outline-none">
				Ligar para
				<span class="tabular block font-mono text-[1.375rem] leading-tight font-semibold tracking-[-0.01em]">{display}</span>
				pelo {viaLabel}?
			</p>
			<p class="text-sm text-pretty text-ink-soft">
				É uma chamada de verdade. O macOS ainda pede um último OK no Mac antes de discar.
			</p>
		</div>
		<input type="hidden" name="confirmed" value="yes" />
		<div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
			<Button type="button" variant="outline" size="lg" onclick={oncancel} disabled={pending}>Voltar e editar</Button>
			<Button type="submit" size="lg" disabled={pending} aria-busy={pending}>
				{#if pending}
					<CircleNotch class="size-4 animate-spin" weight="bold" aria-hidden="true" />
					Enviando ao macOS…
				{:else}
					<PhoneCall class="size-4" weight="bold" aria-hidden="true" />
					Sim, ligar
				{/if}
			</Button>
		</div>
	</div>
{:else}
	<footer class="flex flex-col-reverse gap-3 border-t border-rule bg-paper-sunk px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
		<p class="text-xs text-pretty text-ink-soft">Nada é discado sem a sua confirmação aqui e no Mac.</p>
		<!-- A plain submit button on purpose: without JS this posts ?/review, which shows the confirm step. -->
		<Button type="submit" formaction="?/review" size="lg" class="w-full shrink-0 sm:w-auto" disabled={!ready}>
			<PhoneIcon class="size-4" weight="bold" aria-hidden="true" />
			Revisar chamada
		</Button>
	</footer>
{/if}

<style>
	/* The question unfolds out of the footer; reduced motion keeps only the fade. */
	.confirm {
		transition:
			opacity 200ms var(--ease-out),
			translate 200ms var(--ease-out);

		@starting-style {
			opacity: 0;
			translate: 0 6px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.confirm {
			transition: opacity 160ms ease;
			translate: none;
		}
	}
</style>
