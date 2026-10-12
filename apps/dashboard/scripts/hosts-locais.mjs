// Decide se o Host de uma requisição é de máquina local ou da rede local.
// Usado pelo scripts/serve.mjs: o SvelteKit compara o cabeçalho Origin com a origem montada a partir do Host,
// então só aceitar Hosts locais mantém o CSRF ligado para qualquer site de fora.

/** @param {string} host Host com porta opcional, como `127.0.0.1:7350` ou `[::1]:7350`. */
export function semPorta(host) {
	const h = host.trim().toLowerCase();
	if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
	return h.replace(/:\d+$/, '');
}

/** @param {string} host */
export function hostLocal(host) {
	const nome = semPorta(host);
	if (!nome) return false;
	if (nome === 'localhost' || nome === '::1' || nome.endsWith('.localhost')) return true;
	if (nome.startsWith('fe80:') || nome.startsWith('fc') || nome.startsWith('fd')) return nome.includes(':');
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(nome);
	if (v4) {
		const [a, b] = [Number(v4[1]), Number(v4[2])];
		if (v4.slice(1).some((n) => Number(n) > 255)) return false;
		return a === 127 || (a === 100 && b >= 64 && b <= 127) || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
	}
	// Tailscale MagicDNS (`mac.tailnet.ts.net`); só chega aqui pelo `tailscale serve`, restrito à tailnet.
	if (nome.endsWith('.ts.net')) return true;
	// Bonjour (`mac.local`) ou nome simples da LAN (sem ponto).
	return nome.endsWith('.local') || /^[a-z0-9-]+$/.test(nome);
}

/** Host da tailnet (nome ts.net ou IP 100.64.0.0/10), onde o `tailscale serve` termina o TLS. */
export function hostTailnet(host) {
	const nome = semPorta(host);
	if (nome.endsWith('.ts.net')) return true;
	const v4 = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(nome);
	return !!v4 && Number(v4[1]) >= 64 && Number(v4[1]) <= 127;
}

/**
 * Protocolo da requisição para o SvelteKit montar a origem. `https` só quando o Host é da tailnet e o proxy
 * (tailscale serve, em loopback) mandou `X-Forwarded-Proto: https`; no resto, `http`.
 */
export function protocoloDaRequisicao(host, encaminhado) {
	const proto = String(encaminhado ?? '').split(',')[0].trim().toLowerCase();
	return hostTailnet(host) && proto === 'https' ? 'https' : 'http';
}
