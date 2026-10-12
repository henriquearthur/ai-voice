import { watchTelemetria } from '#lib/server/telemetria.js';
import type { RequestHandler } from './$types';

/** Server-sent events: the whole panel on every change, a comment every 15 s. Proxies the collector's own stream. */
export const GET: RequestHandler = ({ request }) => {
	const encoder = new TextEncoder();
	let stop = () => {};

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const write = (chunk: string) => {
				try {
					controller.enqueue(encoder.encode(chunk));
				} catch {
					stop();
				}
			};
			const unsubscribe = watchTelemetria((painel) => write(`data: ${JSON.stringify(painel)}\n\n`));
			const beat = setInterval(() => write(': ok\n\n'), 15_000);
			write('retry: 3000\n\n');
			stop = () => {
				clearInterval(beat);
				unsubscribe();
				stop = () => {};
			};
			request.signal.addEventListener('abort', () => {
				stop();
				try {
					controller.close();
				} catch {
					// Already closed.
				}
			});
		},
		cancel() {
			stop();
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-store',
			'x-accel-buffering': 'no'
		}
	});
};
