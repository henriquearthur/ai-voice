import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { config } from './config.js';
import { AlexaVoice } from './alexa.js';
import { createServer } from './mcp.js';
import { serveHttp } from './http.js';

process.umask(0o077);
const settings = config();
const voice = new AlexaVoice(settings);
let handle;
if (settings.httpPort === undefined) {
  handle = serveStdio(() => createServer(voice));
  process.stdin.once('end', () => voice.close());
} else {
  handle = await serveHttp(() => createServer(voice), { host: settings.httpHost, port: settings.httpPort });
  console.error(`AI Voice em http://${settings.httpHost}:${handle.port}/mcp`);
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => { voice.close(); await handle.close(); process.exit(0); });
}
