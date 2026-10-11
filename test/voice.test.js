import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import AlexaRemote from 'alexa-remote2';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AlexaVoice, postSpeech } from '../src/alexa.js';
import { saveSession } from '../src/session.js';
import { config } from '../src/config.js';

function state(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ai-voice-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  saveSession(directory, { localCookie: 'fake', refreshToken: 'fake', macDms: {}, amazonPage: 'amazon.com.br' });
  return directory;
}

function fixture(t, online = true) {
  const device = {
    serialNumber: 'TEST-ECHO', accountName: 'Echo de teste', deviceType: 'TEST-TYPE',
    deviceFamily: 'ECHO', deviceOwnerCustomerId: 'TEST-OWNER', online,
  };
  const remote = new AlexaRemote();
  remote.init = (options, callback) => { remote._options = options; callback(); };
  remote.getDevices = (callback) => callback(null, { devices: [device, { deviceFamily: 'WHA', serialNumber: 'GROUP' }] });
  let sent;
  const voice = new AlexaVoice({ stateDir: state(t), speechEnabled: true }, {
    createRemote: () => remote,
    send: async (_, sequence) => { sent = sequence; },
  });
  return { voice, sent: () => sent };
}

test('fala bloqueada por padrão, antes de autenticar ou abrir rede', async () => {
  assert.equal(config({}).speechEnabled, false);
  const voice = new AlexaVoice({ speechEnabled: false }, { createRemote: () => { throw new Error('não deve executar'); } });
  await assert.rejects(voice.speak({ device_serial: 'TEST', text: 'Teste' }), /Fala bloqueada/);
});

test('sessão é privada no filesystem', (t) => {
  const directory = state(t);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(join(directory, 'session.json')).mode & 0o777, 0o600);
});

test('gera fala para um único Echo preservando português e números', async (t) => {
  const { voice, sent } = fixture(t);
  const result = await voice.speak({ device_serial: 'TEST-ECHO', text: 'Olá! O valor é 1.25 e a versão é 2.3.' });
  const node = sent().startNode;
  assert.equal(node.type, 'Alexa.Speak');
  assert.equal(node.operationPayload.deviceSerialNumber, 'TEST-ECHO');
  assert.equal(node.operationPayload.deviceType, 'TEST-TYPE');
  assert.equal(node.operationPayload.customerId, 'TEST-OWNER');
  assert.equal(node.operationPayload.locale, 'pt-BR');
  assert.equal(node.operationPayload.textToSpeak, 'Olá! O valor é 1.25 e a versão é 2.3.');
  assert.equal(result.playback_confirmed, false);
  assert.equal(result.status, 'accepted');
});

test('rejeita vazio, SSML e texto longo antes de conectar', async () => {
  const voice = new AlexaVoice({ speechEnabled: true }, { createRemote: () => { throw new Error('não deve executar'); } });
  for (const text of ['', '  ', '<speak>Olá</speak>', 'a'.repeat(251)]) {
    await assert.rejects(voice.speak({ device_serial: 'TEST', text }), /texto simples/);
  }
});

test('exclui grupos e rejeita dispositivo inexistente/offline sem envio', async (t) => {
  const { voice, sent } = fixture(t, false);
  assert.equal((await voice.devices()).length, 1);
  await assert.rejects(voice.speak({ device_serial: 'GROUP', text: 'Teste' }), /não encontrado/);
  await assert.rejects(voice.speak({ device_serial: 'TEST-ECHO', text: 'Teste' }), /offline/);
  assert.equal(sent(), undefined);
});

test('POST verifica HTTP e erros JSON, não repete e não revela credenciais', async () => {
  let status = 200, body = '', calls = 0;
  const stub = mock.method(https, 'request', (options, callback) => {
    calls++;
    assert.equal(options.path, '/api/behaviors/preview');
    const request = new EventEmitter();
    request.end = (data) => {
      assert.equal(JSON.parse(data).behaviorId, 'PREVIEW');
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = status;
        callback(response);
        response.emit('data', Buffer.from(body));
        response.emit('end');
      });
    };
    return request;
  });
  try {
    const remote = { baseUrl: 'alexa.example', cookie: 'SECRET-COOKIE', csrf: 'SECRET-CSRF' };
    await postSpeech(remote, {});
    status = 403; body = '{"message":"SECRET-COOKIE"}';
    await assert.rejects(postSpeech(remote, {}), /HTTP 403/);
    status = 200;
    await assert.rejects(postSpeech(remote, {}), /retornou um erro/);
    body = '<html>login</html>';
    await assert.rejects(postSpeech(remote, {}), /inesperada/);
    assert.equal(calls, 4);
  } finally { stub.mock.restore(); }
});

test('MCP real via stdio: handshake, descoberta, bloqueio de fala e sessão ausente', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-voice-mcp-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['src/server.js'], cwd: process.cwd(),
    env: { PATH: process.env.PATH, AI_VOICE_STATE_DIR: directory, AI_VOICE_ENABLE_SPEECH: '0' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'ai-voice-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion().name, 'AI Voice');
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['list_devices', 'speak']);
    const result = await client.callTool({ name: 'speak', arguments: { device_serial: 'TEST', text: 'Teste' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Fala bloqueada/);
    const devices = await client.callTool({ name: 'list_devices', arguments: {} });
    assert.equal(devices.isError, true);
    assert.match(devices.content[0].text, /Sessão Amazon ausente/);
  } finally { await client.close(); }
});
