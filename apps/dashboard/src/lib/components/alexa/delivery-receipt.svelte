<script lang="ts">
	import type { SpeechReceipt } from '#lib/alexa/failure.js';
	import ReceiptSlip from '#lib/components/jarvis/receipt-slip.svelte';

	let { receipt }: { receipt: SpeechReceipt } = $props();

	// The Mac returns only after the audio ended; Amazon only says it took the request.
	const mac = $derived(receipt.route === 'mac');
</script>

<ReceiptSlip
	stamp={mac ? 'Falado' : 'Aceito'}
	at={receipt.at}
	title={mac ? 'Falado no Mac: o áudio tocou até o fim.' : 'Aceito pela Alexa. A reprodução não é confirmada.'}
>
	<dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-sm">
		<dt class="field-label self-center">Saída</dt>
		<dd class="truncate text-ink">{mac ? 'Este Mac' : receipt.device}</dd>
		{#if !mac}
			<dt class="field-label self-center">Partes</dt>
			<dd class="tabular text-ink">{receipt.chunks}</dd>
		{/if}
		<dt class="field-label self-center">Reprodução</dt>
		<dd class={mac ? 'text-signal' : 'text-ink-soft'}>
			{receipt.playbackConfirmed ? 'Confirmada' : 'Não confirmada pela Amazon'}
		</dd>
	</dl>

	<blockquote class="line-clamp-3 border-l border-rule-strong pl-3 text-sm text-ink-soft">
		{receipt.text}
	</blockquote>
</ReceiptSlip>
