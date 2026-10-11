import { createServer as createHttpServer } from 'node:http';
import { Readable } from 'node:stream';
import { createMcpHandler } from '@modelcontextprotocol/server';

// Serves MCP on /mcp for clients on other machines. No authentication: listen
// only on a private network address (loopback or a VPN interface).
export function serveHttp(factory, { host, port }) {
  const handler = createMcpHandler(factory);
  const server = createHttpServer(async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url, `http://${incoming.headers.host || 'localhost'}`);
      let response;
      if (url.pathname !== '/mcp') response = new Response('Not found', { status: 404 });
      // MCP clients do not send Origin; browsers do on cross-site requests.
      else if (incoming.headers.origin) response = new Response('Forbidden', { status: 403 });
      else {
        const body = incoming.method === 'GET' || incoming.method === 'HEAD' ? undefined : Readable.toWeb(incoming);
        response = await handler.fetch(new Request(url, { method: incoming.method, headers: incoming.headers, body, duplex: 'half' }));
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body).pipe(outgoing);
      else outgoing.end();
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({
      port: server.address().port,
      close: async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); await handler.close(); },
    }));
  });
}
