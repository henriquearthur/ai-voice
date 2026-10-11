import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

export function createServer(voice) {
  const server = new McpServer({ name: 'AI Voice', version: '0.1.0' });
  const tool = (fn) => async (args) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await fn(args)) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  };
  server.registerTool('list_devices', {
    description: 'Lista Echos físicos da conta Amazon sem reproduzir áudio.',
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, tool(() => voice.devices()));
  server.registerTool('speak', {
    description: 'Reproduz texto na voz da Alexa em um Echo. Exige autorização do usuário e fala habilitada localmente. Não repetir automaticamente em caso de erro: o áudio pode ter sido recebido.',
    inputSchema: z.object({
      device_serial: z.string().trim().min(1).describe('Serial exato retornado por list_devices.'),
      text: z.string().min(1).max(250).describe('Texto simples em português; sem SSML.'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, tool((args) => voice.speak(args)));
  return server;
}
