/** O endereço é deste Mac (127.0.0.0/8 ou ::1, inclusive na forma IPv4 mapeada em IPv6)? */
export function isLoopback(address: string): boolean {
	const a = address.trim().toLowerCase();
	if (a === '::1' || a === '0:0:0:0:0:0:0:1') return true;
	const v4 = a.startsWith('::ffff:') ? a.slice(7) : a;
	return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/**
 * O pedido saiu deste Mac, e não chegou por um proxy local? O `tailscale serve` encaminha de 127.0.0.1,
 * então o endereço sozinho não basta: o Host também precisa ser local e não pode haver X-Forwarded-For.
 */
export function isLocalRequest(address: string, headers: { get(name: string): string | null }): boolean {
	if (!isLoopback(address)) return false;
	if (headers.get('x-forwarded-for') || headers.get('tailscale-user-login')) return false;
	const host = (headers.get('host') ?? '').toLowerCase().replace(/:\d+$/, '');
	return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}
