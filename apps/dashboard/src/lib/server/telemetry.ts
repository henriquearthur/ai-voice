import * as Telemetry from '@jarvis/telemetry';
import { Layer } from 'effect';
import pkg from '../../../package.json' with { type: 'json' };

/**
 * Shared by every Effect runtime of the dashboard, so the OTLP exporter (traces, metrics, logs)
 * is built once per process and both runtimes report as `jarvis-dashboard`.
 */
export const memoMap = Layer.makeMemoMapUnsafe();

export const TelemetryLive = Telemetry.layer({ serviceName: 'jarvis-dashboard', serviceVersion: pkg.version });
