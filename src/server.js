import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { config } from './config.js';
import { AlexaVoice } from './alexa.js';
import { createServer } from './mcp.js';

process.umask(0o077);
const voice = new AlexaVoice(config());
const handle = serveStdio(() => createServer(voice));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => { voice.close(); await handle.close(); process.exit(0); });
}
process.stdin.once('end', () => voice.close());
