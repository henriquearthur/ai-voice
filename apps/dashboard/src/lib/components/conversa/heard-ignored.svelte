<script lang="ts">
	import CaretDown from 'phosphor-svelte/lib/CaretDown';
	import { count, duration, time } from '#lib/conversa/format.js';
	import type { Ignored } from '#lib/conversa/model.js';

	/** What the escuta heard and let go: sentences without "Jarvis" at the start, outside the conversation window. */
	let { ignored, noise }: { ignored: ReadonlyArray<Ignored>; noise: number } = $props();

	let open = $state(false);
</script>

<details bind:open class="ignored sheet group">
	<summary
		class="flex cursor-pointer list-none items-center justify-between gap-3 rounded-[var(--radius-panel)] px-5 py-3.5 select-none [&::-webkit-details-marker]:hidden"
	>
		<span class="flex items-baseline gap-2">
			<span class="text-heading font-semibold text-ink">Frases ignoradas</span>
			<span class="tabular text-meta text-ink-faint">{count(ignored.length)}</span>
		</span>
		<CaretDown
			class="caret size-4 text-ink-soft transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)] group-open:rotate-180"
			weight="bold"
			aria-hidden="true"
		/>
	</summary>

	<div class="border-t border-rule">
		<p class="px-5 pt-3 text-micro text-ink-soft">
			Ouvidas sem “Jarvis” no começo e fora da janela de conversa: ficaram só no Mac, não foram enviadas.
		</p>
		{#if ignored.length === 0}
			<p class="px-5 py-4 text-meta text-ink-soft">Nenhuma frase ignorada no registro.</p>
		{:else}
			<ol class="max-h-[26rem] divide-y divide-rule overflow-y-auto px-5 pb-2 [scrollbar-gutter:stable]">
				{#each ignored as item (item.key)}
					<li class="grid gap-0.5 py-2.5">
						<p class="flex items-baseline justify-between gap-3 text-micro">
							{#if item.armed}
								<span class="font-semibold text-brand">Só “Jarvis”: abriu a escuta</span>
							{:else}
								<span class="text-ink-faint">sem palavra de ativação</span>
							{/if}
							<span class="tabular shrink-0 text-ink-faint">
								{time(item.at)}{item.seconds !== null ? ` · ${duration(item.seconds * 1000)}` : ''}
							</span>
						</p>
						<p class="text-meta text-ink-soft [overflow-wrap:anywhere]">{item.text}</p>
					</li>
				{/each}
			</ol>
		{/if}
		{#if noise > 0}
			<p class="border-t border-rule px-5 py-2.5 text-micro text-ink-faint">
				E mais <span class="tabular">{count(noise)}</span> {noise === 1 ? 'ruído' : 'ruídos'} sem palavras.
			</p>
		{/if}
	</div>
</details>

<style>
	/* The list opens with a short fade and drop; the panel itself just grows. */
	.ignored[open] > div {
		animation: open 220ms var(--ease-out);
	}
	@keyframes open {
		from {
			opacity: 0;
			transform: translateY(-4px);
		}
	}
	summary {
		transition: background-color var(--dur-fast) ease;
	}
	@media (hover: hover) and (pointer: fine) {
		summary:hover {
			background-color: var(--hover);
		}
	}
	summary:focus-visible {
		outline-offset: -2px;
	}
	@media (prefers-reduced-motion: reduce) {
		.ignored[open] > div {
			animation: none;
		}
	}
</style>
