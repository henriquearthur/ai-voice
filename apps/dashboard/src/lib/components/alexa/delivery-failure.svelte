<script lang="ts">
	import type { AlexaFailure } from '#lib/alexa/failure.js';
	import Notice from '#lib/components/jarvis/notice.svelte';

	let { failure }: { failure: AlexaFailure } = $props();

	const titles: Record<AlexaFailure['kind'], string> = {
		session: 'A sessão da Amazon expirou. Nada foi enviado ao Echo.',
		device: 'O Echo não pôde receber. Nada foi enviado.',
		speech: 'A fala foi recusada. Nada foi falado.',
		voice: 'O Mac não conseguiu falar.',
		config: 'A configuração do servidor está incompleta.',
		unexpected: 'O envio falhou no servidor.'
	};

	const recovery: Record<AlexaFailure['kind'], string> = {
		session: 'Rode bun apps/mcp/src/main.ts login no terminal, ou fale pelo Mac.',
		device: 'Confira se o Echo está ligado e online, ou fale pelo Mac.',
		speech: 'Confira se AI_VOICE_ENABLE_SPEECH=1 está definido, revise o texto ou espere a fala anterior terminar.',
		voice: 'Outra fala pode estar ocupando o Mac. Espere terminar antes de tentar de novo; a fala não é repetida sozinha.',
		config: 'Revise as variáveis AI_VOICE_* e reinicie o dashboard.',
		unexpected: 'Tente de novo. Se repetir, veja o terminal do dashboard.'
	};
</script>

<Notice tone="alert" title={titles[failure.kind]}>
	<p>{recovery[failure.kind]}</p>
	<p class="mt-1 text-xs">Resposta: {failure.message}</p>
</Notice>
