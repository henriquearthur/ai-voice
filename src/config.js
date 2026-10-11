import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function config(env = process.env) {
  return {
    stateDir: resolve(env.AI_VOICE_STATE_DIR || join(homedir(), '.local/share/ai-voice')),
    amazonPage: env.AI_VOICE_AMAZON_PAGE || 'amazon.com.br',
    alexaServiceHost: env.AI_VOICE_ALEXA_HOST || undefined,
    speechEnabled: env.AI_VOICE_ENABLE_SPEECH === '1',
    defaultDevice: env.AI_VOICE_DEFAULT_DEVICE || undefined,
  };
}
