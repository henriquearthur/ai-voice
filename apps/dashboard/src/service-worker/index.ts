// Service worker mínimo: guarda só os arquivos imutáveis do build e o que está em `static/`.
// Páginas e dados sempre vêm da rede, porque o painel mostra o estado vivo do Mac.
import { version } from '$app/env';
import { assets, immutable } from '$app/manifest';
import { self } from '$app/service-worker';

const CACHE = `jarvis-${version}`;
const PRECACHE = [...immutable, ...assets].map(({ path }) => new URL(path, self.location.origin).href);
const PRECACHED = new Set(PRECACHE);

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(PRECACHE))
			.then(() => self.skipWaiting())
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
			.then(() => self.clients.claim())
	);
});

self.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET' || !PRECACHED.has(request.url)) return;

	event.respondWith(
		caches.open(CACHE).then(async (cache) => (await cache.match(request)) ?? fetch(request))
	);
});
