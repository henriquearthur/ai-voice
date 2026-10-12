import { json } from '@sveltejs/kit';
import { readPainel } from '#lib/server/telemetria.js';
import type { RequestHandler } from './$types';

/** The collector's state as the page reads it (normalized), plus the latencies from Prometheus. */
export const GET: RequestHandler = async () => json(await readPainel(), { headers: { 'cache-control': 'no-store' } });
