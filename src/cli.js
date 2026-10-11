#!/usr/bin/env node
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
  if (action === undefined) {
    await import('./server.js');
  } else if (action === 'login') {
    mkdirSync(settings.stateDir, { recursive: true, mode: 0o700 });
    chmodSync(settings.stateDir, 0o700);
    let formerRegistrationData;
    try { formerRegistrationData = loadSession(settings.stateDir); } catch { /* First login. */ }
    const stop = () => { AlexaCookie.stopProxyServer(); };
    process.once('SIGINT', () => { stop(); process.exit(130); });
    process.once('SIGTERM', () => { stop(); process.exit(143); });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { stop(); reject(new Error('Login timed out after 10 minutes.')); }, 600000);
      AlexaCookie.generateAlexaCookie(undefined, undefined, {
        amazonPage: settings.amazonPage,
        baseAmazonPage: 'amazon.com',
        acceptLanguage: settings.locale,
        amazonPageProxyLanguage: settings.locale.replace('-', '_'),
        setupProxy: true,
        proxyOnly: true,
        proxyOwnIp: '127.0.0.1',
        proxyListenBind: '127.0.0.1',
        proxyPort: 3456,
        formerDataStorePath: join(settings.stateDir, 'registration.json'),
        formerRegistrationData,
      }, (error, session) => {
        if (error?.message.includes('Please open http://')) {
          console.error('Open http://127.0.0.1:3456/ in a browser on this machine and sign in to Amazon (including MFA). No audio will be played.');
          return;
        }
        clearTimeout(timer);
        stop();
        if (error || !session?.localCookie || !session?.refreshToken || !session?.macDms) {
          reject(new Error('Amazon login failed. Try again; never paste your password, MFA code or cookies into a chat.'));
          return;
        }
        try { saveSession(settings.stateDir, session); resolve(); } catch {
          reject(new Error('Could not save the local session.'));
        }
      });
    });
    console.error('Session saved locally. Run npx @henriquearthur/ai-voice devices to list your Echo devices without audio.');
  } else if (action === 'devices') {
    const voice = new AlexaVoice(settings);
    try { console.log(JSON.stringify(await voice.devices(), null, 2)); }
    finally { voice.close(); }
  } else {
    throw new Error('Usage: ai-voice [login | devices]');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
