import AlexaCookie from 'alexa-cookie2';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { loadSession, saveSession } from './session.js';
import { AlexaVoice } from './alexa.js';

process.umask(0o077);
const settings = config();
const action = process.argv[2];

try {
  if (action === 'login') {
    mkdirSync(settings.stateDir, { recursive: true, mode: 0o700 });
    chmodSync(settings.stateDir, 0o700);
    let formerRegistrationData;
    try { formerRegistrationData = loadSession(settings.stateDir); } catch { /* Primeiro login. */ }
    const stop = () => { AlexaCookie.stopProxyServer(); };
    process.once('SIGINT', () => { stop(); process.exit(130); });
    process.once('SIGTERM', () => { stop(); process.exit(143); });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { stop(); reject(new Error('Login expirou após 10 minutos.')); }, 600000);
      AlexaCookie.generateAlexaCookie(undefined, undefined, {
        amazonPage: settings.amazonPage,
        baseAmazonPage: 'amazon.com',
        acceptLanguage: 'pt-BR',
        amazonPageProxyLanguage: 'pt_BR',
        setupProxy: true,
        proxyOnly: true,
        proxyOwnIp: '127.0.0.1',
        proxyListenBind: '127.0.0.1',
        proxyPort: 3456,
        formerDataStorePath: join(settings.stateDir, 'registration.json'),
        formerRegistrationData,
      }, (error, session) => {
        if (error?.message.includes('Please open http://')) {
          console.error('Abra http://127.0.0.1:3456/ no navegador deste Mac e faça login na Amazon (incluindo MFA). Nenhum áudio será enviado.');
          return;
        }
        clearTimeout(timer);
        stop();
        if (error || !session?.localCookie || !session?.refreshToken || !session?.macDms) {
          reject(new Error('Login Amazon falhou. Tente novamente; não envie senha, MFA ou cookies no chat.'));
          return;
        }
        try { saveSession(settings.stateDir, session); resolve(); } catch {
          reject(new Error('Não foi possível salvar a sessão local.'));
        }
      });
    });
    console.error('Sessão salva localmente. Execute npm run devices para verificar os Echos sem áudio.');
  } else if (action === 'devices') {
    const voice = new AlexaVoice(settings);
    try { console.log(JSON.stringify(await voice.devices(), null, 2)); }
    finally { voice.close(); }
  } else {
    throw new Error('Uso: npm run login | npm run devices');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
