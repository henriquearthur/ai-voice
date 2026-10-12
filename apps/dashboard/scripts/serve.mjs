// Servidor de produção do Jarvis. Substitui o index.js do adapter-node (que fica ao lado, em .local/app).
//
// Motivo: sem ORIGIN, o adapter-node monta a origem da requisição com protocolo `https` por padrão, então um
// formulário vindo de http://127.0.0.1:7350 trazia `Origin: http://...` e o SvelteKit respondia
// "403 Cross-site POST form submissions are forbidden". Aqui o protocolo é `http` e só Hosts locais ou da LAN
// são atendidos (421 para o resto), mantendo o CSRF do SvelteKit ligado contra sites de fora.
import { existsSync } from 'node:fs';
import http from 'node:http';
import process from 'node:process';
import { hostLocal, protocoloDaRequisicao } from './hosts-locais.mjs';

process.env.PROTOCOL_HEADER ??= 'x-jarvis-proto';
// Publicado: handler.js fica ao lado; em desenvolvimento (`bun run start`) vem de ../build.
const alvo = existsSync(new URL('./handler.js', import.meta.url)) ? './handler.js' : '../build/handler.js';
const { handler } = await import(alvo);

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 7350);
const timeoutEncerrar = Number(process.env.SHUTDOWN_TIMEOUT ?? 30);

const server = http.createServer((req, res) => {
	if (!hostLocal(String(req.headers.host ?? ''))) {
		res.statusCode = 421;
		res.end('Host não permitido');
		return;
	}
	req.headers[process.env.PROTOCOL_HEADER] = protocoloDaRequisicao(String(req.headers.host ?? ''), req.headers['x-forwarded-proto']);
	handler(req, res, () => {
		res.statusCode = 404;
		res.end();
	});
});

let encerrando = false;
function encerrar(motivo) {
	if (encerrando) return;
	encerrando = true;
	server.closeIdleConnections();
	server.close((erro) => {
		if (!erro) process.emit('sveltekit:shutdown', motivo);
	});
	setTimeout(() => server.closeAllConnections(), timeoutEncerrar * 1000).unref();
}
process.on('SIGTERM', encerrar);
process.on('SIGINT', encerrar);

server.listen({ host, port }, () => console.log(`Listening on http://${host}:${port}`));
