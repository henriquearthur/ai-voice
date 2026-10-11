import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { MAX_TEXT_LENGTH } from './speech.js';

export function createServer(voice) {
  const server = new McpServer({ name: 'AI Voice', version: '0.2.0' }, {
    instructions: `Use speak when the user asks for a spoken reply. Prefer short messages in the language of locale ${voice.settings.locale}. Listing devices plays no sound. Do not send unprompted test speech and do not repeat speech after an error or timeout. Success means the API accepted the request, not that the user heard it.`,
  });
  const tool = (fn) => async (args) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await fn(args)) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  };
  server.registerTool('list_devices', {
    description: 'Lists the physical Echo devices on the Amazon account without playing audio.',
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, tool(() => voice.devices()));
  server.registerTool('speak', {
    description: `Speaks text in the Alexa voice on an Echo device, using locale ${voice.settings.locale}. Uses the default Echo when device_serial is omitted. Long text is split into an ordered sequence. Use when the user asks for speech; do not retry automatically after an error or timeout.`,
    inputSchema: z.object({
      device_serial: z.string().trim().min(1).optional().describe('Serial returned by list_devices. Omit to use AI_VOICE_DEFAULT_DEVICE.'),
      text: z.string().min(1).max(MAX_TEXT_LENGTH).describe('Plain text, up to 4000 UTF-16 code units; no SSML.'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, tool((args) => voice.speak(args)));
  return server;
}
