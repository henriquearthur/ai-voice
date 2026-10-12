import { describe, expect, test } from 'bun:test';
// @ts-expect-error módulo .mjs sem tipos
import { hostLocal, protocoloDaRequisicao } from '../scripts/hosts-locais.mjs';

describe('hostLocal', () => {
	test.each(['127.0.0.1:7350', 'localhost:7350', '[::1]:7350', '192.168.0.12:7350', '10.1.2.3', '172.16.0.5:7350', 'mac-do-fernando.local:7350', 'macbook', 'macbook-pro-de-fernando.taild47e86.ts.net:8350', '100.64.118.95:8350', '100.127.0.1'])(
		'aceita %s',
		(h) => expect(hostLocal(h)).toBe(true)
	);
	test.each(['evil.com', 'evil.com:7350', '8.8.8.8:7350', '172.32.0.1', '192.169.0.1', '999.1.1.1', '100.63.0.1', '100.128.0.1', 'evil.com.ts.net.evil.com', 'a.b.example', ''])('recusa %s', (h) =>
		expect(hostLocal(h)).toBe(false)
	);
});

describe('protocoloDaRequisicao', () => {
	const ts = 'macbook-pro-de-fernando.taild47e86.ts.net:8350';
	test('https na tailnet com X-Forwarded-Proto https', () => expect(protocoloDaRequisicao(ts, 'https')).toBe('https'));
	test('http na tailnet sem cabeçalho', () => expect(protocoloDaRequisicao(ts, undefined)).toBe('http'));
	test('http em host local mesmo com cabeçalho', () => expect(protocoloDaRequisicao('127.0.0.1:7350', 'https')).toBe('http'));
});
