<script lang="ts">
	import type { Echo } from '@jarvis/alexa';
	import { untrack } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import ArrowUUpLeft from 'phosphor-svelte/lib/ArrowUUpLeft';
	import CircleNotch from 'phosphor-svelte/lib/CircleNotch';
	import PaperPlaneTilt from 'phosphor-svelte/lib/PaperPlaneTilt';
	import SpeakerHigh from 'phosphor-svelte/lib/SpeakerHigh';
	import type { AlexaFailure, MacVoiceStatus, Outcome, SpeechReceipt } from '#lib/alexa/failure.js';
	import { voiceName } from '#lib/alexa/voice.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import Notice from '#lib/components/jarvis/notice.svelte';
	import DeliveryFailure from './delivery-failure.svelte';
	import DeliveryReceipt from './delivery-receipt.svelte';
	import DeviceLedger from './device-ledger.svelte';
	import SpeakingBars from './speaking-bars.svelte';

	type Result =
		| { text: string; device: string; invalid: string }
		| { text: string; device: string; failure: AlexaFailure }
		| { device: string; accepted: SpeechReceipt }
		| null
		| undefined;

	let {
		voice,
		echoes,
		speechEnabled,
		maxLength,
		result
	}: {
		voice: Outcome<MacVoiceStatus>;
		echoes?: Outcome<ReadonlyArray<Echo>>;
		speechEnabled?: boolean;
		maxLength: number;
		result: Result;
	} = $props();

	// Seeded once from the last submission (no-JS round trip); otherwise the Mac, the default route.
	const seed = untrack(() => result);
	let device = $state(seed?.device || 'mac');
	let text = $state(seed && 'text' in seed ? seed.text : '');
	let pending = $state(false);
	let formElement = $state<HTMLFormElement>();
	let textarea = $state<HTMLTextAreaElement>();

	/** What left from this tab, newest first. Lives only as long as the tab: nothing is stored. */
	let spoken = $state<SpeechReceipt[]>(seed && 'accepted' in seed ? [seed.accepted] : []);

	const devices = $derived(echoes?.ok ? echoes.value : undefined);
	const onMac = $derived(device === 'mac');
	const target = $derived(onMac ? undefined : devices?.find((d) => d.serial === device));
	const routeReady = $derived(onMac ? voice.ok : !!target?.online);

	const length = $derived(text.length);
	const over = $derived(length > maxLength);
	const blank = $derived(text.trim() === '');
	const ready = $derived(speechEnabled === true && routeReady && !blank && !over && !pending);

	const invalid = $derived(result && 'invalid' in result ? result.invalid : undefined);
	const failure = $derived(result && 'failure' in result ? result.failure : undefined);
	const accepted = $derived(result && 'accepted' in result ? result.accepted : undefined);
	const earlier = $derived(spoken.slice(accepted ? 1 : 0, 6));

	const submit: SubmitFunction = () => {
		pending = true;
		return async ({ result, update }) => {
			// Speaking changes neither the voice nor the Echo list: skip the extra Amazon round trip.
			await update({ reset: false, refreshAll: false });
			if (result.type === 'success') {
				text = '';
				const receipt = (result.data as { accepted?: SpeechReceipt } | undefined)?.accepted;
				if (receipt) spoken = [receipt, ...spoken].slice(0, 12);
			}
			pending = false;
		};
	};

	function onkeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && ready) {
			event.preventDefault();
			formElement?.requestSubmit();
		}
	}

	function reuse(line: SpeechReceipt) {
		text = line.text;
		textarea?.focus();
	}

	const clock = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
</script>

<form
	bind:this={formElement}
	method="POST"
	action="?/speak"
	use:enhance={submit}
	class="grid items-start gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_minmax(17rem,21rem)] xl:gap-x-14"
>
	<div class="grid min-w-0 gap-5">
		<div class="sheet">
			<div class="flex items-baseline justify-between gap-4 border-b border-rule px-5 pt-4 pb-3">
				<label for="speak-text" class="field-label">Mensagem</label>
				<span class="min-w-0 truncate text-sm text-ink-soft">
					{#if onMac}
						sai por <span class="font-semibold text-ink">Este Mac</span>{#if voice.ok}{' '}<span class="text-ink-soft">
								· {voice.value.engine === 'kokoro' ? voiceName(voice.value.voice) : voice.value.voice}</span
							>{/if}
					{:else if target}
						sai pelo Echo <span class="font-semibold text-ink">{target.name}</span>
					{:else}
						escolha uma saída
					{/if}
				</span>
			</div>

			<textarea
				id="speak-text"
				data-bare
				name="text"
				bind:this={textarea}
				bind:value={text}
				{onkeydown}
				rows="6"
				required
				maxlength={maxLength + 200}
				aria-invalid={invalid || over ? 'true' : undefined}
				aria-describedby="speak-meta{invalid ? ' speak-invalid' : ''}"
				placeholder="O que o Jarvis deve falar?"
				disabled={speechEnabled === false}
				class="ruled block min-h-[10.5rem] w-full resize-y bg-transparent px-5 pt-1.5 pb-0 text-[1.125rem] text-ink outline-none placeholder:text-ink-soft/80 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
			></textarea>

			<div class="flex flex-wrap items-center justify-between gap-3 border-t border-rule px-5 py-3">
				<p id="speak-meta" class="flex items-center gap-3 text-xs text-ink-soft">
					<span class={['tabular font-mono', over && 'font-semibold text-alert']}>
						{length.toLocaleString('pt-BR')} / {maxLength.toLocaleString('pt-BR')}
					</span>
					<span class="hidden sm:inline">
						<kbd class="rounded-sm border border-rule-strong px-1 text-[0.6875rem]">⌘</kbd>
						<kbd class="rounded-sm border border-rule-strong px-1 text-[0.6875rem]">Enter</kbd>
						{onMac ? 'fala' : 'envia'}
					</span>
				</p>
				<Button type="submit" size="lg" class="ml-auto min-w-[11.5rem]" disabled={!ready} aria-busy={pending}>
					{#if pending && onMac}
						<SpeakingBars active class="text-[1rem]" />
						Falando no Mac…
					{:else if pending}
						<CircleNotch class="size-4 animate-spin" weight="bold" aria-hidden="true" />
						Enviando…
					{:else if onMac}
						<SpeakerHigh class="size-4" weight="bold" aria-hidden="true" />
						Falar no Mac
					{:else}
						<PaperPlaneTilt class="size-4" weight="bold" aria-hidden="true" />
						<span class="max-w-[14rem] truncate">Enviar para {target?.name ?? 'o Echo'}</span>
					{/if}
				</Button>
			</div>
		</div>

		{#if pending && onMac}
			<p class="text-sm text-ink-soft" role="status">O Mac responde quando o áudio terminar de tocar.</p>
		{/if}

		{#if invalid}
			<p id="speak-invalid" class="text-sm font-medium text-alert">{invalid}</p>
		{/if}

		{#if speechEnabled === false}
			<Notice tone="caution" title="A fala está desativada neste servidor.">
				Defina <code>AI_VOICE_ENABLE_SPEECH=1</code> e reinicie o dashboard. Vale para o Mac e para os Echos.
			</Notice>
		{:else if !onMac && target && !target.online}
			<Notice tone="caution" title="{target.name} ficou offline.">
				Escolha outra saída ou ligue o Echo e atualize a lista.
			</Notice>
		{/if}

		<div aria-live="polite">
			{#if failure}
				<DeliveryFailure {failure} />
			{:else if accepted}
				{#key accepted.at}
					<DeliveryReceipt receipt={accepted} />
				{/key}
			{:else if speechEnabled !== false}
				<p class="perforated pt-4 text-sm text-ink-soft">
					O comprovante aparece aqui. No Mac, ele só sai depois que o áudio terminou; num Echo, a Amazon confirma
					só que aceitou o pedido.
				</p>
			{/if}
		</div>

		{#if earlier.length > 0}
			<section aria-labelledby="earlier-heading" class="min-w-0">
				<h2 id="earlier-heading" class="field-label mb-1.5">Antes, nesta aba</h2>
				<ol class="divide-y divide-rule border-y border-rule">
					{#each earlier as line (line.at)}
						<li class="grid grid-cols-[3rem_minmax(0,1fr)_auto] items-center gap-x-3 py-2">
							<time class="tabular font-mono text-xs text-ink-soft" datetime={new Date(line.at).toISOString()}>
								{clock.format(line.at)}
							</time>
							<span class="min-w-0">
								<span class="block truncate text-sm text-ink">{line.text}</span>
								<span class="block text-xs text-ink-soft">
									{line.route === 'mac' ? 'Este Mac, falado' : `${line.device}, aceito`}
								</span>
							</span>
							<button
								type="button"
								class="reuse"
								onclick={() => reuse(line)}
								aria-label="Reusar o texto: {line.text.slice(0, 60)}"
							>
								<ArrowUUpLeft class="size-3.5" weight="bold" aria-hidden="true" />
								<span class="hidden sm:inline">Reusar</span>
							</button>
						</li>
					{/each}
				</ol>
			</section>
		{/if}
	</div>

	<DeviceLedger {voice} {echoes} bind:value={device} speaking={pending && onMac} />
</form>

<style>
	.reuse {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		border-radius: 3px;
		padding: 0.25rem 0.5rem;
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--ink-soft);
		transition:
			color 150ms ease,
			background-color 150ms ease,
			scale 160ms var(--ease-out);
	}

	.reuse:active {
		scale: 0.97;
	}

	@media (hover: hover) and (pointer: fine) {
		.reuse:hover {
			color: var(--ink);
			background-color: var(--accent);
		}
	}
</style>
