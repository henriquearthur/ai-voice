import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import AlexaRemote from 'alexa-remote2';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AlexaVoice, postSpeech } from '../src/alexa.js';
import { saveSession, loadSession } from '../src/session.js';
import { config } from '../src/config.js';
import { MAX_TEXT_LENGTH, splitSpeech } from '../src/speech.js';
import { createServer } from '../src/mcp.js';
import { serveHttp } from '../src/http.js';

function state(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ai-voice-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  saveSession(directory, { localCookie: 'csrf=TEST;', refreshToken: 'fake', macDms: {}, amazonPage: 'amazon.com.br', tokenDate: Date.now() });
  return directory;
}

function fixture(t, online = true) {
  const device = {
    serialNumber: 'TEST-ECHO', accountName: 'Echo de teste', deviceType: 'TEST-TYPE',
    deviceFamily: 'ECHO', deviceOwnerCustomerId: 'TEST-OWNER', online,
  };
  const remote = new AlexaRemote();
  remote.checkAuthentication = (callback) => callback(true);
  remote.getEndpoints = (callback) => callback(null, { websiteApiUrl: 'https://alexa.example' });
  remote.getDevices = (callback) => callback(null, { devices: [device, { deviceFamily: 'WHA', serialNumber: 'GROUP' }] });
  let sent;
  const voice = new AlexaVoice({ stateDir: state(t), speechEnabled: true }, {
    createRemote: () => remote,
    send: async (_, sequence) => { sent = sequence; },
  });
  t.after(() => voice.close());
  return { voice, remote, sent: () => sent };
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
  for (const text of ['', '  ', '<speak>Olá</speak>', 'a'.repeat(MAX_TEXT_LENGTH + 1)]) {
    await assert.rejects(voice.speak({ device_serial: 'TEST', text }), /texto simples/);
  }
});

test('divide textos longos sem quebrar palavras, frases ou emojis na fronteira', () => {
  const text = 'Uma frase curta em português. '.repeat(60).trim();
  const parts = splitSpeech(text);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length > 0 && part.length <= 250));
  assert.equal(parts.join(' '), text);
  for (const edge of ['a'.repeat(249) + '😀oi', 'a'.repeat(250) + '.oi', 'a'.repeat(4000)]) {
    const chunks = splitSpeech(edge);
    assert.ok(chunks.every((chunk) => chunk.length <= 250 && chunk.isWellFormed()));
    assert.equal(chunks.join(''), edge);
  }
});

test('usa Echo padrão e envia todos os trechos em um único SerialNode', async (t) => {
  const { voice, sent } = fixture(t);
  voice.settings.defaultDevice = 'TEST-ECHO';
  const text = 'Este é um texto que será falado em partes ordenadas. '.repeat(12).trim();
  const result = await voice.speak({ text });
  assert.equal((await voice.devices())[0].is_default, true);
  const node = sent().startNode;
  assert.equal(node['@type'], 'com.amazon.alexa.behaviors.model.SerialNode');
  assert.equal(node.nodesToExecute.length, result.chunks);
  assert.equal(node.nodesToExecute.map((part) => part.operationPayload.textToSpeak).join(' '), text);
  assert.ok(node.nodesToExecute.every((part) => part.operationPayload.locale === 'pt-BR' && part.operationPayload.deviceSerialNumber === 'TEST-ECHO'));
});

test('não escolhe destino automaticamente quando não há Echo padrão', async (t) => {
  const { voice, sent } = fixture(t);
  await assert.rejects(voice.speak({ text: 'Teste' }), /AI_VOICE_DEFAULT_DEVICE/);
  assert.equal(sent(), undefined);
});

test('renova sessão antiga e persiste os tokens sem abrir proxy', async (t) => {
  const { voice, remote } = fixture(t);
  const previous = loadSession(voice.settings.stateDir);
  previous.tokenDate = Date.now() - 25 * 60 * 60 * 1000;
  saveSession(voice.settings.stateDir, previous);
  let refreshes = 0;
  remote.refreshCookie = (callback) => {
    assert.equal(remote._options.setupProxy, false);
    refreshes++;
    callback(null, { ...previous, localCookie: 'csrf=RENEWED;', refreshToken: 'new-token', macDms: { token: 'new-jwt' }, tokenDate: Date.now() });
  };
  await voice.devices();
  assert.equal(refreshes, 1);
  assert.equal(loadSession(voice.settings.stateDir).refreshToken, 'new-token');
  assert.equal(remote.csrf, 'RENEWED');
  assert.deepEqual(remote.macDms, { token: 'new-jwt' });
});

test('refresh após cookie inválido ocorre uma vez; falha não entra em loop', async (t) => {
  const { voice, remote } = fixture(t);
  let refreshes = 0;
  remote.checkAuthentication = (callback) => callback(false);
  remote.refreshCookie = (callback) => {
    refreshes++;
    callback(null, loadSession(voice.settings.stateDir));
  };
  await assert.rejects(voice.devices(), /Sessão Amazon inválida/);
  assert.equal(refreshes, 1);
  assert.equal(voice.connecting, undefined);
});

test('processo persistente verifica autenticação novamente após 30 minutos', async (t) => {
  const { voice, remote } = fixture(t);
  let checks = 0;
  remote.checkAuthentication = (callback) => { checks++; callback(true); };
  await voice.devices();
  await voice.devices();
  assert.equal(checks, 1);
  voice.connectedAt = Date.now() - 31 * 60 * 1000;
  await voice.devices();
  assert.equal(checks, 2);
});

test('falha na renovação orienta novo login e permite tentar novamente', async (t) => {
  const { voice, remote } = fixture(t);
  remote.checkAuthentication = (callback) => callback(false);
  remote.refreshCookie = (callback) => callback(new Error('SECRET-TOKEN'));
  await assert.rejects(voice.devices(), /npm run login/);
  assert.equal(voice.connecting, undefined);
  remote.checkAuthentication = (callback) => callback(true);
  assert.equal((await voice.devices()).length, 1);
});

test('rejeita envio concorrente e nunca repete fala quando transporte falha', async (t) => {
  const { voice } = fixture(t);
  let fail;
  let sends = 0;
  voice.send = () => {
    sends++;
    return new Promise((_, reject) => { fail = reject; });
  };
  const first = voice.speak({ device_serial: 'TEST-ECHO', text: 'Teste' });
  await assert.rejects(voice.speak({ device_serial: 'TEST-ECHO', text: 'Outro teste' }), /em andamento/);
  await new Promise((resolve) => setImmediate(resolve));
  fail(new Error('Falha simulada'));
  await assert.rejects(first, /Falha simulada/);
  assert.equal(sends, 1);
  assert.equal(voice.speaking, false);
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

test('MCP via HTTP: ferramentas em /mcp, bloqueio de fala e recusa de navegador', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-voice-http-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const voice = new AlexaVoice(config({ AI_VOICE_STATE_DIR: directory }));
  const handle = await serveHttp(() => createServer(voice), { host: '127.0.0.1', port: 0 });
  t.after(() => handle.close());
  const url = `http://127.0.0.1:${handle.port}/mcp`;
  const client = new Client({ name: 'ai-voice-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['list_devices', 'speak']);
    const result = await client.callTool({ name: 'speak', arguments: { device_serial: 'TEST', text: 'Teste' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Fala bloqueada/);
  } finally { await client.close(); }
  const browser = await fetch(url, { method: 'POST', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(browser.status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${handle.port}/`)).status, 404);
});
