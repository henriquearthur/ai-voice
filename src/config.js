import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import pkg from '../package.json' with { type: 'json' };

export const { version } = pkg;

export function config(env = process.env) {
  return {
    stateDir: resolve(env.AI_VOICE_STATE_DIR || join(homedir(), '.local/share/ai-voice')),
    amazonPage: env.AI_VOICE_AMAZON_PAGE || 'amazon.com',
    locale: env.AI_VOICE_LOCALE || 'en-US',
    alexaServiceHost: env.AI_VOICE_ALEXA_HOST || undefined,
    speechEnabled: env.AI_VOICE_ENABLE_SPEECH === '1',
    defaultDevice: env.AI_VOICE_DEFAULT_DEVICE || undefined,
    httpPort: env.AI_VOICE_HTTP_PORT ? Number(env.AI_VOICE_HTTP_PORT) : undefined,
    httpHost: env.AI_VOICE_HTTP_HOST || '127.0.0.1',
  };
}
