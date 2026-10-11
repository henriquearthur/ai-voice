import https from 'node:https';
import AlexaRemote from 'alexa-remote2';
import { loadSession, saveSession } from './session.js';
import { splitSpeech, speechSequence } from './speech.js';

const AUTH_CHECK_INTERVAL = 30 * 60 * 1000;
const TOKEN_REFRESH_INTERVAL = 24 * 60 * 60 * 1000;

export function validateSpeech({ device_serial, text }, settings) {
  if (!settings.speechEnabled) {
    throw new Error('Fala bloqueada. Após autorização do usuário, configure AI_VOICE_ENABLE_SPEECH=1 e reinicie o MCP.');
  }
  if (typeof device_serial !== 'string' || !device_serial.trim()) throw new Error('Informe device_serial ou configure AI_VOICE_DEFAULT_DEVICE.');
  return splitSpeech(text);
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
        'User-Agent': 'AI-Voice/0.2.0',
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
    if (this.connectedAt && Date.now() - this.connectedAt >= AUTH_CHECK_INTERVAL) this.close();
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
    // Inicializar só autenticação e endpoint. Evitar init(), que pode repetir login
    // recursivamente e consultar recursos que este MCP não usa.
    remote._options = {
      amazonPage: session.amazonPage || this.settings.amazonPage,
      baseAmazonPage: 'amazon.com',
      acceptLanguage: 'pt-BR',
      apiUserAgentPostfix: 'AI-Voice/0.2.0',
      setupProxy: false,
      // Sem logger: a biblioteca registra cookies/tokens em debug.
    };
    remote.baseUrl = this.settings.alexaServiceHost || `alexa.${remote._options.amazonPage}`;
    remote.setCookie(session);
    const refresh = async () => {
      const renewed = await new Promise((resolve, reject) => remote.refreshCookie((error, result) => {
        if (error || !result?.localCookie || !result?.refreshToken || !result?.macDms) {
          return reject(new Error('Sessão Amazon expirou e não pôde ser renovada. Execute npm run login.'));
        }
        resolve(result);
      }));
      // setCookie conserva macDms prévio; atualizar também o token renovado.
      remote._options.macDms = renewed.macDms;
      remote.setCookie(renewed);
      saveSession(this.settings.stateDir, renewed);
    };
    let refreshed = false;
    if (!session.tokenDate || Date.now() - session.tokenDate >= TOKEN_REFRESH_INTERVAL) {
      await refresh();
      refreshed = true;
    }
    const authenticated = () => new Promise((resolve, reject) => remote.checkAuthentication((valid, error) => {
      if (valid === null) return reject(new Error('Não foi possível conectar à Alexa. Verifique a conexão e tente novamente.'));
      resolve(valid === true && !error);
    }));
    if (!await authenticated()) {
      if (refreshed) throw new Error('Sessão Amazon inválida. Execute npm run login.');
      await refresh();
      if (!await authenticated()) throw new Error('Sessão Amazon inválida. Execute npm run login.');
    }
    remote.lastAuthCheck = Date.now();
    const endpoints = await new Promise((resolve) => remote.getEndpoints((error, result) => resolve(error ? undefined : result)));
    if (endpoints?.websiteApiUrl) {
      remote.baseUrl = new URL(endpoints.websiteApiUrl).hostname;
    }
    this.connectedAt = Date.now();
    return remote;
  }

  async devices() {
    const remote = await this.connect();
    const result = await new Promise((resolve, reject) => remote.getDevices((error, result) => {
      if (error || !Array.isArray(result?.devices)) {
        this.close();
        return reject(new Error('Não foi possível listar dispositivos Alexa. A próxima chamada verificará a sessão novamente.'));
      }
      resolve(result);
    }));
    // Excluir apps, grupos e outros dispositivos: um Echo físico por chamada.
    const echoes = result.devices.filter((device) => device.deviceFamily === 'ECHO');
    this.echoes = echoes;
    return echoes.map((device) => ({
      name: device.accountName,
      serial: device.serialNumber,
      online: device.online,
      is_default: device.serialNumber === this.settings.defaultDevice,
    }));
  }

  async speak(args) {
    const serial = args.device_serial || this.settings.defaultDevice;
    const chunks = validateSpeech({ ...args, device_serial: serial }, this.settings);
    if (this.speaking) throw new Error('Já existe um envio de fala em andamento neste servidor. Aguarde sua conclusão.');
    this.speaking = true;
    try {
      await this.devices();
      const device = this.echoes.find((item) => item.serialNumber === serial);
      if (!device) throw new Error('Echo não encontrado. Use um serial retornado por list_devices.');
      if (!device.online) throw new Error('Echo está offline.');
      const remote = await this.connect();
      await this.send(remote, speechSequence(remote, device, chunks));
      return { status: 'accepted', device: device.accountName, chunks: chunks.length, playback_confirmed: false };
    } finally {
      this.speaking = false;
    }
  }

  close() {
    this.remote?.stop();
    this.remote = undefined;
    this.connecting = undefined;
    this.connectedAt = undefined;
  }
}
