import { spawnSync } from 'node:child_process';
import { SECRET_IDS, SECRET_SERVICE, type SecretId } from '#lib/onboarding/model.js';

/**
 * Segredos no Keychain de login (conta "jarvis", os mesmos serviços que o MCP já lê). O valor entra pelo
 * stdin do `security -i`, nunca na linha de comando (que apareceria no `ps`), e nunca volta para a página:
 * ela só fica sabendo se o item existe.
 */
export const KEYCHAIN_ACCOUNT = 'jarvis';

/** Rejeita o que o `security -i` não aceita entre aspas, e valores absurdos. */
export function validSecret(value: string): boolean {
	return value.length > 0 && value.length <= 4096 && !/["\\\n\r\0]/.test(value);
}

/** O comando para o stdin do `security -i`. */
export function addCommand(id: SecretId, value: string): string {
	if (!validSecret(value)) throw new Error('valor inválido: sem aspas, barra invertida ou quebra de linha');
	return `add-generic-password -U -a ${KEYCHAIN_ACCOUNT} -s ${SECRET_SERVICE[id]} -w "${value}"\n`;
}

export function saveSecret(id: SecretId, value: string): void {
	const r = spawnSync('/usr/bin/security', ['-i'], { input: addCommand(id, value), encoding: 'utf8', timeout: 10_000 });
	if (r.status !== 0) throw new Error(`o Keychain recusou (${r.status})`);
	if (!hasSecret(id)) throw new Error('o Keychain não guardou o item');
}

export function hasSecret(id: SecretId): boolean {
	const r = spawnSync('/usr/bin/security', ['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', SECRET_SERVICE[id]], {
		stdio: 'ignore',
		timeout: 5_000
	});
	return r.status === 0;
}

export function secretsState(): Record<SecretId, boolean> {
	return Object.fromEntries(SECRET_IDS.map((id) => [id, hasSecret(id)])) as Record<SecretId, boolean>;
}
