# @jarvis/dashboard

Painel do Jarvis (SvelteKit 3 + shadcn-svelte). O primeiro módulo é a Alexa: lista os Echos da conta e envia texto para um deles falar.

## Rodar

```sh
# uma vez, na raiz do monorepo: cria a sessão da Amazon
bun apps/mcp/src/main.ts login

# dev
cd apps/dashboard
AI_VOICE_AMAZON_PAGE=amazon.com.br AI_VOICE_LOCALE=pt-BR AI_VOICE_ENABLE_SPEECH=1 \
AI_VOICE_DEFAULT_DEVICE=<serial> bun run dev
```

As variáveis estão descritas em `.env.example`. Build de produção: `bun run build && node build`.

## Estrutura

- `src/lib/server/alexa-runtime.ts`: o único `ManagedRuntime` do Effect (Alexa + config + Node + fetch).
- `src/lib/server/alexa-gateway.ts`: roda os efeitos e devolve `Outcome` serializável com falhas seguras.
- `src/routes/+page.server.ts`: `load` (config + Echos) e a action `speak`.
- `src/lib/jarvis/modules.ts`: registro dos módulos da navegação.
- `src/lib/components/jarvis`: shell e primitivos compartilhados; `src/lib/components/ui`: shadcn-svelte.
- `src/routes/layout.css`: tokens de design (claro = formulário, escuro = papel-carbono).
