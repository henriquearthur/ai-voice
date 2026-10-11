import { mkdirSync, chmodSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export function saveSession(stateDir, session) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const file = join(stateDir, 'session.json');
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(session), { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

export function loadSession(stateDir) {
  try {
    const session = JSON.parse(readFileSync(join(stateDir, 'session.json'), 'utf8'));
    if (!session.localCookie || !session.refreshToken || !session.macDms) throw new Error();
    return session;
  } catch {
    throw new Error('Amazon session is missing or invalid. Run npm run login on the machine that hosts AI Voice.');
  }
}
