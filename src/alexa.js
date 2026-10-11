import https from 'node:https';
import AlexaRemote from 'alexa-remote2';
import { loadSession, saveSession } from './session.js';

export function validateSpeech({ device_serial, text }, settings) {
  if (!settings.speechEnabled) {
    throw new Error('Fala bloqueada. Após autorização do usuário, configure AI_VOICE_ENABLE_SPEECH=1 e reinicie o MCP.');
  }
  if (typeof device_serial !== 'string' || !device_serial.trim()) throw new Error('Informe o serial de um Echo.');
  if (typeof text !== 'string' || !text.trim() || text.length > 250 || /[<>]/u.test(text)) {
    throw new Error('Use texto simples entre 1 e 250 caracteres, sem SSML.');
  }
}

// Um envio apenas: timeout/erro não autoriza repetir uma fala possivelmente recebida.
export function postSpeech(remote, sequence) {
  const data = JSON.stringify({ behaviorId: 'PREVIEW', sequenceJson: JSON.stringify(sequence), status: 'ENABLED' });
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: remote.baseUrl,
      path: '/api/behaviors/preview',
      method: 'POST',
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(data),
        Cookie: remote.cookie,
        csrf: remote.csrf,
        'User-Agent': 'AI-Voice/0.1.0',
        'Accept-Language': 'pt-BR',
        Origin: `https://${remote.baseUrl}`,
        Referer: `https://${remote.baseUrl}/spa/index.html`,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', () => reject(new Error('Resposta Alexa interrompida; reprodução não confirmada.')));
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return reject(new Error(`Alexa recusou o envio (HTTP ${response.statusCode}).`));
        }
        const body = Buffer.concat(chunks).toString('utf8');
        if (body.trim()) {
          let result;
          try { result = JSON.parse(body); } catch {
            return reject(new Error('Resposta Alexa inesperada; reprodução não confirmada.'));
          }
          if (!result || typeof result !== 'object' || Array.isArray(result)) {
            return reject(new Error('Resposta Alexa inesperada; reprodução não confirmada.'));
          }
          if (result.error || result.errors || result.errorMessage || result.message || result.code || result.success === false) {
            return reject(new Error('Alexa retornou um erro; reprodução não confirmada.'));
          }
        }
        resolve();
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', () => reject(new Error('Falha de conexão com Alexa; reprodução não confirmada. Não repetir automaticamente.')));
    request.end(data);
  });
}

export class AlexaVoice {
  constructor(settings, { createRemote = () => new AlexaRemote(), send = postSpeech } = {}) {
    this.settings = settings;
    this.createRemote = createRemote;
    this.send = send;
  }

  async connect() {
    if (this.connecting) return this.connecting;
    this.connecting = this.initialize().catch((error) => {
      this.close();
      this.connecting = undefined;
      throw error;
    });
    return this.connecting;
  }

  async initialize() {
    const session = loadSession(this.settings.stateDir);
    const remote = this.remote = this.createRemote();
    remote.on('cookie', () => {
      if (remote.cookieData?.refreshToken) saveSession(this.settings.stateDir, remote.cookieData);
    });
    await new Promise((resolve, reject) => {
      remote.init({
        cookie: session,
        formerRegistrationData: session,
        amazonPage: session.amazonPage || this.settings.amazonPage,
        alexaServiceHost: this.settings.alexaServiceHost,
        acceptLanguage: 'pt-BR',
        setupProxy: false,
        cookieRefreshInterval: 0,
        usePushConnection: false,
        bluetooth: false,
        notifications: false,
        // Não habilitar logger: a biblioteca registra cookies/tokens em debug.
      }, (error) => error ? reject(new Error('Não foi possível autenticar na Alexa. Execute npm run login.')) : resolve());
    });
    return remote;
  }

  async devices() {
    const remote = await this.connect();
    const result = await new Promise((resolve, reject) => remote.getDevices((error, result) => {
      if (error || !Array.isArray(result?.devices)) return reject(new Error('Não foi possível listar dispositivos Alexa.'));
      resolve(result);
    }));
    // Excluir apps, grupos e outros dispositivos: a prova visa um Echo físico por vez.
    this.echoes = result.devices.filter((device) => device.deviceFamily === 'ECHO');
    return this.echoes.map((device) => ({
      name: device.accountName,
      serial: device.serialNumber,
      online: device.online,
      capabilities: device.capabilities || [],
    }));
  }

  async speak(args) {
    validateSpeech(args, this.settings); // Bloqueio antes de ler sessão ou abrir rede.
    await this.devices();
    const device = this.echoes.find((item) => item.serialNumber === args.device_serial);
    if (!device) throw new Error('Echo não encontrado. Use um serial retornado por list_devices.');
    if (!device.online) throw new Error('Echo está offline.');
    const remote = await this.connect();
    // A fábrica da biblioteca usa de-DE e pode transformar números: preservar o texto.
    remote.serialNumbers[device.serialNumber] = device;
    const startNode = remote.createSequenceNode('speak', args.text, device.serialNumber);
    startNode.operationPayload.locale = 'pt-BR';
    startNode.operationPayload.textToSpeak = args.text;
    await this.send(remote, { '@type': 'com.amazon.alexa.behaviors.model.Sequence', startNode });
    return { status: 'accepted', device: device.accountName, playback_confirmed: false };
  }

  close() {
    this.remote?.stop();
  }
}
