<script lang="ts">
	import type { Reminder } from '@jarvis/apple';
	import ReceiptSlip from '#lib/components/jarvis/receipt-slip.svelte';
	import { describeDue } from '#lib/reminders/due.js';

	let { reminder, at }: { reminder: Reminder; at: number } = $props();

	const due = $derived(reminder.due ? describeDue(reminder.due, new Date(at)) : null);
</script>

<ReceiptSlip stamp="Anotado" {at} title="Salvo no app Lembretes.">
	<dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-1.5 text-sm">
		<dt class="field-label self-center">Lista</dt>
		<dd class="truncate text-ink">{reminder.list}</dd>
		<dt class="field-label self-center">Quando</dt>
		<dd class={due ? 'text-ink first-letter:uppercase' : 'text-ink-soft'}>
			{#if due}{due.day}{due.time ? ` · ${due.time}` : ''}{:else}Sem data{/if}
		</dd>
	</dl>

	<p class="line-clamp-2 border-l border-rule-strong pl-3 text-sm text-ink-soft">{reminder.title}</p>
</ReceiptSlip>
