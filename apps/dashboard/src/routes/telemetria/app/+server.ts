import { json } from '@sveltejs/kit';
import { readAppWeb } from '#lib/server/telemetria-app.js';
import type { RequestHandler } from './$types';

/** The "App" section's numbers (the frontend's own telemetry, last hour), read from Prometheus. */
export const GET: RequestHandler = async () => json(await readAppWeb(), { headers: { 'cache-control': 'no-store' } });
