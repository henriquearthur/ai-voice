import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { MAX_TEXT_LENGTH } from './speech.js';

export function createServer(voice) {
  const server = new McpServer({ name: 'AI Voice', version: '0.2.0' }, {
    instructions: 'Use speak quando o usuário pedir uma resposta falada. Prefira mensagens breves em português. Listar dispositivos não produz som. Não envie testes espontâneos nem repita falas após erro ou timeout. O sucesso indica aceitação pela API, não confirmação de que o usuário ouviu.',
  });
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
    description: 'Fala texto em português na voz da Alexa em um Echo. Usa o Echo padrão quando device_serial é omitido. Textos longos são divididos em uma sequência ordenada. Use quando o usuário pedir fala; não repita automaticamente após erro ou timeout.',
    inputSchema: z.object({
      device_serial: z.string().trim().min(1).optional().describe('Serial retornado por list_devices. Omita para usar AI_VOICE_DEFAULT_DEVICE.'),
      text: z.string().min(1).max(MAX_TEXT_LENGTH).describe('Texto simples em português, até 4000 unidades UTF-16; sem SSML.'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, tool((args) => voice.speak(args)));
  return server;
}
